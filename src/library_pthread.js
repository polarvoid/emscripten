/**
 * @license
 * Copyright 2015 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 *
 * Because only modern JS engines support SAB we can use modern JS language
 * features within this file (ES2020).
 */

#if !USE_PTHREADS
#error "Internal error! USE_PTHREADS should be enabled when including library_pthread.js."
#endif
#if !SHARED_MEMORY
#error "Internal error! SHARED_MEMORY should be enabled when including library_pthread.js."
#endif
#if USE_PTHREADS == 2
#error "USE_PTHREADS=2 is no longer supported"
#endif
#if BUILD_AS_WORKER
#error "USE_PTHREADS + BUILD_AS_WORKER require separate modes that don't work together, see https://github.com/emscripten-core/emscripten/issues/8854"
#endif
#if PROXY_TO_WORKER
#error "--proxy-to-worker is not supported with -sUSE_PTHREADS>0! Use the option -sPROXY_TO_PTHREAD if you want to run the main thread of a multithreaded application in a web worker."
#endif
#if EVAL_CTORS
#error "EVAL_CTORS is not compatible with pthreads yet (passive segments)"
#endif
#if STANDALONE_WASM
#error "STANDALONE_WASM does not support shared memories yet"
#endif

var LibraryPThread = {
  $PThread__postset: 'PThread.init();',
  $PThread__deps: ['_emscripten_thread_init',
                   '$killThread',
                   '$cancelThread', '$cleanupThread', '$zeroMemory',
                   '$spawnThread',
                   '_emscripten_thread_free_data',
                   'exit',
#if PTHREADS_DEBUG || ASSERTIONS
                   '$ptrToString',
#endif
#if !MINIMAL_RUNTIME
                   '$handleException',
#endif
                   ],
  $PThread: {
    // Contains all Workers that are idle/unused and not currently hosting an
    // executing pthread.  Unused Workers can either be pooled up before page
    // startup, but also when a pthread quits, its hosting Worker is not
    // terminated, but is returned to this pool as an optimization so that
    // starting the next thread is faster.
    unusedWorkers: [],
    // Contains all Workers that are currently hosting an active pthread.
    runningWorkers: [],
    tlsInitFunctions: [],
    // Maps pthread_t pointers to the workers on which they are running.  For
    // the reverse mapping, each worker has a `pthread_ptr` when its running a
    // pthread.
    pthreads: {},
#if PTHREADS_DEBUG
    nextWorkerID: 1,
    debugInit: function() {
      function pthreadLogPrefix() {
        var t = 0;
        if (runtimeInitialized && typeof _pthread_self != 'undefined'
#if EXIT_RUNTIME
        && !runtimeExited
#endif
        ) {
          t = _pthread_self();
        }
        return 'w:' + (Module['workerID'] || 0) + ',t:' + ptrToString(t) + ': ';
      }

      // When PTHREAD_DEBUG is enabled, prefix all err() messages with the calling
      // thread ID.
      var origErr = err;
      err = (message) => origErr(pthreadLogPrefix() + message);
    },
#endif
    init: function() {
#if PTHREADS_DEBUG
      PThread.debugInit();
#endif
      if (ENVIRONMENT_IS_PTHREAD) {
        PThread.initWorker();
      } else {
        PThread.initMainThread();
      }
    },
    initMainThread: function() {
#if PTHREAD_POOL_SIZE
      var pthreadPoolSize = {{{ PTHREAD_POOL_SIZE }}};
      // Start loading up the Worker pool, if requested.
      while (pthreadPoolSize--) {
        PThread.allocateUnusedWorker();
      }
#endif
    },

    initWorker: function() {
#if USE_CLOSURE_COMPILER
      // worker.js is not compiled together with us, and must access certain
      // things.
      PThread['receiveObjectTransfer'] = PThread.receiveObjectTransfer;
      PThread['threadInitTLS'] = PThread.threadInitTLS;
#if !MINIMAL_RUNTIME
      PThread['setExitStatus'] = PThread.setExitStatus;
#endif
#endif

#if !MINIMAL_RUNTIME
      // The default behaviour for pthreads is always to exit once they return
      // from their entry point (or call pthread_exit).  If we set noExitRuntime
      // to true here on pthreads they would never complete and attempt to
      // pthread_join to them would block forever.
      // pthreads can still choose to set `noExitRuntime` explicitly, or
      // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
      // their main function.  See comment in src/worker.js for more.
      noExitRuntime = false;
#endif
    },

#if PTHREADS_PROFILING
    getThreadName: function(pthreadPtr) {
      var profilerBlock = {{{ makeGetValue('pthreadPtr', C_STRUCTS.pthread.profilerBlock, POINTER_TYPE) }}};
      if (!profilerBlock) return "";
      return UTF8ToString(profilerBlock + {{{ C_STRUCTS.thread_profiler_block.name }}});
    },

    threadStatusToString: function(threadStatus) {
      switch (threadStatus) {
        case 0: return "not yet started";
        case 1: return "running";
        case 2: return "sleeping";
        case 3: return "waiting for a futex";
        case 4: return "waiting for a mutex";
        case 5: return "waiting for a proxied operation";
        case 6: return "finished execution";
        default: return "unknown (corrupt?!)";
      }
    },

    threadStatusAsString: function(pthreadPtr) {
      var profilerBlock = {{{ makeGetValue('pthreadPtr', C_STRUCTS.pthread.profilerBlock, POINTER_TYPE) }}};
      var status = (profilerBlock == 0) ? 0 : Atomics.load(HEAPU32, (profilerBlock + {{{ C_STRUCTS.thread_profiler_block.threadStatus }}} ) >> 2);
      return PThread.threadStatusToString(status);
    },
#endif

#if !MINIMAL_RUNTIME
    setExitStatus: function(status) {
      EXITSTATUS = status;
    },
#endif

    terminateAllThreads: function() {
#if ASSERTIONS
      assert(!ENVIRONMENT_IS_PTHREAD, 'Internal Error! terminateAllThreads() can only ever be called from main application thread!');
#endif
#if PTHREADS_DEBUG
      err('terminateAllThreads');
#endif
      for (var worker of Object.values(PThread.pthreads)) {
#if ASSERTIONS
        assert(worker);
#endif
        PThread.returnWorkerToPool(worker);
      }

#if ASSERTIONS
      // At this point there should be zero pthreads and zero runningWorkers.
      // All workers should be now be the unused queue.
      assert(Object.keys(PThread.pthreads).length === 0);
      assert(PThread.runningWorkers.length === 0);
#endif

      for (var worker of PThread.unusedWorkers) {
#if ASSERTIONS
        // This Worker should not be hosting a pthread at this time.
        assert(!worker.pthread_ptr);
#endif
        worker.terminate();
      }
      PThread.unusedWorkers = [];
    },
    returnWorkerToPool: function(worker) {
      // We don't want to run main thread queued calls here, since we are doing
      // some operations that leave the worker queue in an invalid state until
      // we are completely done (it would be bad if free() ends up calling a
      // queued pthread_create which looks at the global data structures we are
      // modifying). To achieve that, defer the free() til the very end, when
      // we are all done.
      var pthread_ptr = worker.pthread_ptr;
      delete PThread.pthreads[pthread_ptr];
      // Note: worker is intentionally not terminated so the pool can
      // dynamically grow.
      PThread.unusedWorkers.push(worker);
      PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1);
      // Not a running Worker anymore
      // Detach the worker from the pthread object, and return it to the
      // worker pool as an unused worker.
      worker.pthread_ptr = 0;

      // Finally, free the underlying (and now-unused) pthread structure in
      // linear memory.
      __emscripten_thread_free_data(pthread_ptr);
    },
    receiveObjectTransfer: function(data) {
#if OFFSCREENCANVAS_SUPPORT
      if (typeof GL != 'undefined') {
        Object.assign(GL.offscreenCanvases, data.offscreenCanvases);
        if (!Module['canvas'] && data.moduleCanvasId && GL.offscreenCanvases[data.moduleCanvasId]) {
          Module['canvas'] = GL.offscreenCanvases[data.moduleCanvasId].offscreenCanvas;
          Module['canvas'].id = data.moduleCanvasId;
        }
      }
#endif
    },
    // Called by worker.js each time a thread is started.
    threadInitTLS: function() {
#if PTHREADS_DEBUG
      err('threadInitTLS.');
#endif
      // Call thread init functions (these are the _emscripten_tls_init for each
      // module loaded.
      PThread.tlsInitFunctions.forEach((f) => f());
    },
    // Loads the WebAssembly module into the given list of Workers.
    // onFinishedLoading: A callback function that will be called once all of
    //                    the workers have been initialized and are
    //                    ready to host pthreads.
    loadWasmModuleToWorker: function(worker, onFinishedLoading) {
      worker.onmessage = (e) => {
        var d = e['data'];
        var cmd = d['cmd'];
        // Sometimes we need to backproxy events to the calling thread (e.g.
        // HTML5 DOM events handlers such as
        // emscripten_set_mousemove_callback()), so keep track in a globally
        // accessible variable about the thread that initiated the proxying.
        if (worker.pthread_ptr) PThread.currentProxiedOperationCallerThread = worker.pthread_ptr;

        // If this message is intended to a recipient that is not the main thread, forward it to the target thread.
        if (d['targetThread'] && d['targetThread'] != _pthread_self()) {
          var targetWorker = PThread.pthreads[d.targetThread];
          if (targetWorker) {
            targetWorker.postMessage(d, d['transferList']);
          } else {
            err('Internal error! Worker sent a message "' + cmd + '" to target pthread ' + d['targetThread'] + ', but that thread no longer exists!');
          }
          PThread.currentProxiedOperationCallerThread = undefined;
          return;
        }

        if (cmd === 'processProxyingQueue') {
          executeNotifiedProxyingQueue(d['queue']);
        } else if (cmd === 'spawnThread') {
          spawnThread(d);
        } else if (cmd === 'cleanupThread') {
          cleanupThread(d['thread']);
        } else if (cmd === 'killThread') {
          killThread(d['thread']);
        } else if (cmd === 'cancelThread') {
          cancelThread(d['thread']);
        } else if (cmd === 'loaded') {
          worker.loaded = true;
          if (onFinishedLoading) onFinishedLoading(worker);
          // If this Worker is already pending to start running a thread, launch the thread now
          if (worker.runPthread) {
            worker.runPthread();
            delete worker.runPthread;
          }
        } else if (cmd === 'print') {
          out('Thread ' + d['threadId'] + ': ' + d['text']);
        } else if (cmd === 'printErr') {
          err('Thread ' + d['threadId'] + ': ' + d['text']);
        } else if (cmd === 'alert') {
          alert('Thread ' + d['threadId'] + ': ' + d['text']);
        } else if (d.target === 'setimmediate') {
          // Worker wants to postMessage() to itself to implement setImmediate()
          // emulation.
          worker.postMessage(d);
#if expectToReceiveOnModule('onAbort')
        } else if (cmd === 'onAbort') {
          if (Module['onAbort']) {
            Module['onAbort'](d['arg']);
          }
#endif
        } else if (cmd) {
          // The received message looks like something that should be handled by this message
          // handler, (since there is a e.data.cmd field present), but is not one of the
          // recognized commands:
          err("worker sent an unknown command " + cmd);
        }
        PThread.currentProxiedOperationCallerThread = undefined;
      };

      worker.onerror = (e) => {
        var message = 'worker sent an error!';
#if ASSERTIONS
        if (worker.pthread_ptr) {
          message = 'Pthread ' + ptrToString(worker.pthread_ptr) + ' sent an error!';
        }
#endif
        err(message + ' ' + e.filename + ':' + e.lineno + ': ' + e.message);
        throw e;
      };

#if ENVIRONMENT_MAY_BE_NODE
      if (ENVIRONMENT_IS_NODE) {
        worker.on('message', function(data) {
          worker.onmessage({ data: data });
        });
        worker.on('error', function(e) {
          worker.onerror(e);
        });
        worker.on('detachedExit', function() {
          // TODO: update the worker queue?
          // See: https://github.com/emscripten-core/emscripten/issues/9763
        });
      }
#endif

#if ASSERTIONS
      assert(wasmMemory instanceof WebAssembly.Memory, 'WebAssembly memory should have been loaded by now!');
      assert(wasmModule instanceof WebAssembly.Module, 'WebAssembly Module should have been loaded by now!');
#endif

      // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
      worker.postMessage({
        'cmd': 'load',
        // If the application main .js file was loaded from a Blob, then it is not possible
        // to access the URL of the current script that could be passed to a Web Worker so that
        // it could load up the same file. In that case, developer must either deliver the Blob
        // object in Module['mainScriptUrlOrBlob'], or a URL to it, so that pthread Workers can
        // independently load up the same main application file.
        'urlOrBlob': Module['mainScriptUrlOrBlob']
#if !EXPORT_ES6
        || _scriptDir
#endif
        ,
#if WASM2JS
        // the polyfill WebAssembly.Memory instance has function properties,
        // which will fail in postMessage, so just send a custom object with the
        // property we need, the buffer
        'wasmMemory': { 'buffer': wasmMemory.buffer },
#else // WASM2JS
        'wasmMemory': wasmMemory,
#endif // WASM2JS
        'wasmModule': wasmModule,
#if LOAD_SOURCE_MAP
        'wasmSourceMap': wasmSourceMap,
#endif
#if USE_OFFSET_CONVERTER
        'wasmOffsetConverter': wasmOffsetConverter,
#endif
#if MAIN_MODULE
        'dynamicLibraries': Module['dynamicLibraries'],
#endif
#if PTHREADS_DEBUG
        'workerID': PThread.nextWorkerID++,
#endif
      });
    },

    // Creates a new web Worker and places it in the unused worker pool to wait for its use.
    allocateUnusedWorker: function() {
#if MINIMAL_RUNTIME
      var pthreadMainJs = Module['worker'];
#else
#if EXPORT_ES6 && USE_ES6_IMPORT_META
      // If we're using module output and there's no explicit override, use bundler-friendly pattern.
      if (!Module['locateFile']) {
#if PTHREADS_DEBUG
        err('Allocating a new web worker from ' + new URL('{{{ PTHREAD_WORKER_FILE }}}', import.meta.url));
#endif
#if TRUSTED_TYPES
        // Use Trusted Types compatible wrappers.
        if (typeof trustedTypes != 'undefined' && trustedTypes.createPolicy) {
          var p = trustedTypes.createPolicy(
            'emscripten#workerPolicy1',
            {
              createScriptURL: function(ignored) {
                return new URL('{{{ PTHREAD_WORKER_FILE }}}', import.meta.url);
              }
            }
          );
          PThread.unusedWorkers.push(new Worker(p.createScriptURL('ignored')));
        } else
#endif
        PThread.unusedWorkers.push(new Worker(new URL('{{{ PTHREAD_WORKER_FILE }}}', import.meta.url)));
        return;
      }
#endif
      // Allow HTML module to configure the location where the 'worker.js' file will be loaded from,
      // via Module.locateFile() function. If not specified, then the default URL 'worker.js' relative
      // to the main html file is loaded.
      var pthreadMainJs = locateFile('{{{ PTHREAD_WORKER_FILE }}}');
#endif
#if PTHREADS_DEBUG
      err('Allocating a new web worker from ' + pthreadMainJs);
#endif
#if TRUSTED_TYPES
      // Use Trusted Types compatible wrappers.
      if (typeof trustedTypes != 'undefined' && trustedTypes.createPolicy) {
        var p = trustedTypes.createPolicy('emscripten#workerPolicy2', { createScriptURL: function(ignored) { return pthreadMainJs } });
        PThread.unusedWorkers.push(new Worker(p.createScriptURL('ignored')));
      } else
#endif
      PThread.unusedWorkers.push(new Worker(pthreadMainJs));
    },

    getNewWorker: function() {
      if (PThread.unusedWorkers.length == 0) {
#if !PROXY_TO_PTHREAD && PTHREAD_POOL_SIZE_STRICT
#if ASSERTIONS
        err('Tried to spawn a new thread, but the thread pool is exhausted.\n' +
        'This might result in a deadlock unless some threads eventually exit or the code explicitly breaks out to the event loop.\n' +
        'If you want to increase the pool size, use setting `-sPTHREAD_POOL_SIZE=...`.'
#if PTHREAD_POOL_SIZE_STRICT == 1
        + '\nIf you want to throw an explicit error instead of the risk of deadlocking in those cases, use setting `-sPTHREAD_POOL_SIZE_STRICT=2`.'
#endif
        );
#endif // ASSERTIONS

#if PTHREAD_POOL_SIZE_STRICT == 2
        // Don't return a Worker, which will translate into an EAGAIN error.
        return;
#endif
#endif
        PThread.allocateUnusedWorker();
        PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);
      }
      return PThread.unusedWorkers.pop();
    }
  },

  $killThread__deps: ['_emscripten_thread_free_data'],
  $killThread: function(pthread_ptr) {
#if PTHREADS_DEBUG
    err('killThread ' + ptrToString(pthread_ptr));
#endif
#if ASSERTIONS
    assert(!ENVIRONMENT_IS_PTHREAD, 'Internal Error! killThread() can only ever be called from main application thread!');
    assert(pthread_ptr, 'Internal Error! Null pthread_ptr in killThread!');
#endif
    var worker = PThread.pthreads[pthread_ptr];
    delete PThread.pthreads[pthread_ptr];
    worker.terminate();
    __emscripten_thread_free_data(pthread_ptr);
    // The worker was completely nuked (not just the pthread execution it was hosting), so remove it from running workers
    // but don't put it back to the pool.
    PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1); // Not a running Worker anymore.
    worker.pthread_ptr = 0;
  },

  __emscripten_thread_cleanup: function(thread) {
    // Called when a thread needs to be cleaned up so it can be reused.
    // A thread is considered reusable when it either returns from its
    // entry point, calls pthread_exit, or acts upon a cancellation.
    // Detached threads are responsible for calling this themselves,
    // otherwise pthread_join is responsible for calling this.
    if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread);
    else postMessage({ 'cmd': 'cleanupThread', 'thread': thread });
  },

  $cleanupThread: function(pthread_ptr) {
#if ASSERTIONS
    assert(!ENVIRONMENT_IS_PTHREAD, 'Internal Error! cleanupThread() can only ever be called from main application thread!');
    assert(pthread_ptr, 'Internal Error! Null pthread_ptr in cleanupThread!');
#endif
    var worker = PThread.pthreads[pthread_ptr];
    assert(worker);
    PThread.returnWorkerToPool(worker);
  },

#if MAIN_MODULE
  $registerTLSInit: function(tlsInitFunc, moduleExports, metadata) {
#if DYLINK_DEBUG
    err("registerTLSInit: " + tlsInitFunc);
#endif
    // In relocatable builds, we use the result of calling tlsInitFunc
    // (`_emscripten_tls_init`) to relocate the TLS exports of the module
    // according to this new __tls_base.
    function tlsInitWrapper() {
      var __tls_base = tlsInitFunc();
#if DYLINK_DEBUG
      err('tlsInit -> ' + __tls_base);
#endif
      if (!__tls_base) {
#if ASSERTIONS
        // __tls_base should never be zero if there are tls exports
        assert(__tls_base || metadata.tlsExports.size == 0);
#endif
        return;
      }
      var tlsExports = {};
      metadata.tlsExports.forEach((s) => tlsExports[s] = moduleExports[s]);
      relocateExports(tlsExports, __tls_base, /*replace=*/true);
    }

    // Register this function so that its gets called for each thread on
    // startup.
    PThread.tlsInitFunctions.push(tlsInitWrapper);

    // If the main thread is already running we also need to call this function
    // now.  If the main thread is not yet running this will happen when it
    // is initialized and processes `PThread.tlsInitFunctions`.
    if (runtimeInitialized) {
      tlsInitWrapper();
    }
  },
#else
  $registerTLSInit: function(tlsInitFunc) {
    PThread.tlsInitFunctions.push(tlsInitFunc);
  },
#endif

  $cancelThread: function(pthread_ptr) {
#if ASSERTIONS
    assert(!ENVIRONMENT_IS_PTHREAD, 'Internal Error! cancelThread() can only ever be called from main application thread!');
    assert(pthread_ptr, 'Internal Error! Null pthread_ptr in cancelThread!');
#endif
    var worker = PThread.pthreads[pthread_ptr];
    worker.postMessage({ 'cmd': 'cancel' });
  },

  $spawnThread: function(threadParams) {
#if ASSERTIONS
    assert(!ENVIRONMENT_IS_PTHREAD, 'Internal Error! spawnThread() can only ever be called from main application thread!');
    assert(threadParams.pthread_ptr, 'Internal error, no pthread ptr!');
#endif

    var worker = PThread.getNewWorker();
    if (!worker) {
      // No available workers in the PThread pool.
      return {{{ cDefine('EAGAIN') }}};
    }
#if ASSERTIONS
    assert(!worker.pthread_ptr, 'Internal error!');
#endif

    PThread.runningWorkers.push(worker);

    // Add to pthreads map
    PThread.pthreads[threadParams.pthread_ptr] = worker;

    worker.pthread_ptr = threadParams.pthread_ptr;
    var msg = {
        'cmd': 'run',
        'start_routine': threadParams.startRoutine,
        'arg': threadParams.arg,
        'pthread_ptr': threadParams.pthread_ptr,
    };
#if OFFSCREENCANVAS_SUPPORT
    // Note that we do not need to quote these names because they are only used
    // in this file, and not from the external worker.js.
    msg.moduleCanvasId = threadParams.moduleCanvasId;
    msg.offscreenCanvases = threadParams.offscreenCanvases;
#endif
    worker.runPthread = () => {
      // Ask the worker to start executing its pthread entry point function.
      msg.time = performance.now();
      worker.postMessage(msg, threadParams.transferList);
    };
    if (worker.loaded) {
      worker.runPthread();
      delete worker.runPthread;
    }
    return 0;
  },

  emscripten_has_threading_support: function() {
    return typeof SharedArrayBuffer != 'undefined';
  },

  emscripten_num_logical_cores: function() {
#if ENVIRONMENT_MAY_BE_NODE
    if (ENVIRONMENT_IS_NODE) return require('os').cpus().length;
#endif
    return navigator['hardwareConcurrency'];
  },

  __emscripten_init_main_thread_js: function(tb) {
    // Pass the thread address to the native code where they stored in wasm
    // globals which act as a form of TLS. Global constructors trying
    // to access this value will read the wrong value, but that is UB anyway.
    __emscripten_thread_init(
      tb,
      /*isMainBrowserThread=*/!ENVIRONMENT_IS_WORKER,
      /*isMainRuntimeThread=*/1,
      /*canBlock=*/!ENVIRONMENT_IS_WEB,
#if PTHREADS_PROFILING
      /*start_profiling=*/true
#endif
    );
    PThread.threadInitTLS();
  },

  $pthreadCreateProxied__internal: true,
  $pthreadCreateProxied__proxy: 'sync',
  $pthreadCreateProxied__deps: ['__pthread_create_js'],
  $pthreadCreateProxied: function(pthread_ptr, attr, startRoutine, arg) {
    return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg);
  },

  // ASan wraps the emscripten_builtin_pthread_create call in
  // __lsan::ScopedInterceptorDisabler.  Unfortunately, that only disables it on
  // the thread that made the call.  __pthread_create_js gets proxied to the
  // main thread, where LSan is not disabled. This makes it necessary for us to
  // disable LSan here (using __noleakcheck), so that it does not detect
  // pthread's internal allocations as leaks.  If/when we remove all the
  // allocations from __pthread_create_js we could also remove this.
  __pthread_create_js__noleakcheck: true,
  __pthread_create_js__sig: 'iiiii',
  __pthread_create_js__deps: ['$spawnThread', 'pthread_self', '$pthreadCreateProxied'],
  __pthread_create_js: function(pthread_ptr, attr, startRoutine, arg) {
    if (typeof SharedArrayBuffer == 'undefined') {
      err('Current environment does not support SharedArrayBuffer, pthreads are not available!');
      return {{{ cDefine('EAGAIN') }}};
    }
#if PTHREADS_DEBUG
    err("createThread: " + ptrToString(pthread_ptr));
#endif

    // List of JS objects that will transfer ownership to the Worker hosting the thread
    var transferList = [];
    var error = 0;

#if OFFSCREENCANVAS_SUPPORT
    // Deduce which WebGL canvases (HTMLCanvasElements or OffscreenCanvases) should be passed over to the
    // Worker that hosts the spawned pthread.
    // Comma-delimited list of CSS selectors that must identify canvases by IDs: "#canvas1, #canvas2, ..."
    var transferredCanvasNames = attr ? {{{ makeGetValue('attr', C_STRUCTS.pthread_attr_t._a_transferredcanvases, POINTER_TYPE) }}} : 0;
#if OFFSCREENCANVASES_TO_PTHREAD
    // Proxied canvases string pointer -1 is used as a special token to fetch
    // whatever canvases were passed to build in -s
    // OFFSCREENCANVASES_TO_PTHREAD= command line.
    if (transferredCanvasNames == (-1 >>> 0)) transferredCanvasNames = '{{{ OFFSCREENCANVASES_TO_PTHREAD }}}';
    else
#endif
    if (transferredCanvasNames) transferredCanvasNames = UTF8ToString(transferredCanvasNames).trim();
    if (transferredCanvasNames) transferredCanvasNames = transferredCanvasNames.split(',');
#if GL_DEBUG
    err('pthread_create: transferredCanvasNames="' + transferredCanvasNames + '"');
#endif

    var offscreenCanvases = {}; // Dictionary of OffscreenCanvas objects we'll transfer to the created thread to own
    var moduleCanvasId = Module['canvas'] ? Module['canvas'].id : '';
    // Note that transferredCanvasNames might be null (so we cannot do a for-of loop).  
    for (var i in transferredCanvasNames) {
      var name = transferredCanvasNames[i].trim();
      var offscreenCanvasInfo;
      try {
        if (name == '#canvas') {
          if (!Module['canvas']) {
            err('pthread_create: could not find canvas with ID "' + name + '" to transfer to thread!');
            error = {{{ cDefine('EINVAL') }}};
            break;
          }
          name = Module['canvas'].id;
        }
#if ASSERTIONS
        assert(typeof GL == 'object', 'OFFSCREENCANVAS_SUPPORT assumes GL is in use (you can force-include it with \'-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=$GL\')');
#endif
        if (GL.offscreenCanvases[name]) {
          offscreenCanvasInfo = GL.offscreenCanvases[name];
          GL.offscreenCanvases[name] = null; // This thread no longer owns this canvas.
          if (Module['canvas'] instanceof OffscreenCanvas && name === Module['canvas'].id) Module['canvas'] = null;
        } else if (!ENVIRONMENT_IS_PTHREAD) {
          var canvas = (Module['canvas'] && Module['canvas'].id === name) ? Module['canvas'] : document.querySelector(name);
          if (!canvas) {
            err('pthread_create: could not find canvas with ID "' + name + '" to transfer to thread!');
            error = {{{ cDefine('EINVAL') }}};
            break;
          }
          if (canvas.controlTransferredOffscreen) {
            err('pthread_create: cannot transfer canvas with ID "' + name + '" to thread, since the current thread does not have control over it!');
            error = {{{ cDefine('EPERM') }}}; // Operation not permitted, some other thread is accessing the canvas.
            break;
          }
          if (canvas.transferControlToOffscreen) {
#if GL_DEBUG
            err('pthread_create: canvas.transferControlToOffscreen(), transferring canvas by name "' + name + '" (DOM id="' + canvas.id + '") from main thread to pthread');
#endif
            // Create a shared information block in heap so that we can control
            // the canvas size from any thread.
            if (!canvas.canvasSharedPtr) {
              canvas.canvasSharedPtr = _malloc(12);
              {{{ makeSetValue('canvas.canvasSharedPtr', 0, 'canvas.width', 'i32') }}};
              {{{ makeSetValue('canvas.canvasSharedPtr', 4, 'canvas.height', 'i32') }}};
              {{{ makeSetValue('canvas.canvasSharedPtr', 8, 0, 'i32') }}}; // pthread ptr to the thread that owns this canvas, filled in below.
            }
            offscreenCanvasInfo = {
              offscreenCanvas: canvas.transferControlToOffscreen(),
              canvasSharedPtr: canvas.canvasSharedPtr,
              id: canvas.id
            }
            // After calling canvas.transferControlToOffscreen(), it is no
            // longer possible to access certain operations on the canvas, such
            // as resizing it or obtaining GL contexts via it.
            // Use this field to remember that we have permanently converted
            // this Canvas to be controlled via an OffscreenCanvas (there is no
            // way to undo this in the spec)
            canvas.controlTransferredOffscreen = true;
          } else {
            err('pthread_create: cannot transfer control of canvas "' + name + '" to pthread, because current browser does not support OffscreenCanvas!');
            // If building with OFFSCREEN_FRAMEBUFFER=1 mode, we don't need to
            // be able to transfer control to offscreen, but WebGL can be
            // proxied from worker to main thread.
#if !OFFSCREEN_FRAMEBUFFER
            err('pthread_create: Build with -sOFFSCREEN_FRAMEBUFFER to enable fallback proxying of GL commands from pthread to main thread.');
            return {{{ cDefine('ENOSYS') }}}; // Function not implemented, browser doesn't have support for this.
#endif
          }
        }
        if (offscreenCanvasInfo) {
          transferList.push(offscreenCanvasInfo.offscreenCanvas);
          offscreenCanvases[offscreenCanvasInfo.id] = offscreenCanvasInfo;
        }
      } catch(e) {
        err('pthread_create: failed to transfer control of canvas "' + name + '" to OffscreenCanvas! Error: ' + e);
        return {{{ cDefine('EINVAL') }}}; // Hitting this might indicate an implementation bug or some other internal error
      }
    }
#endif

    // Synchronously proxy the thread creation to main thread if possible. If we
    // need to transfer ownership of objects, then proxy asynchronously via
    // postMessage.
    if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
      return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
    }

    // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
    // with the detected error.
    if (error) return error;

#if OFFSCREENCANVAS_SUPPORT
    // Register for each of the transferred canvases that the new thread now
    // owns the OffscreenCanvas.
    for (var canvas of Object.values(offscreenCanvases)) {
      // pthread ptr to the thread that owns this canvas.
      {{{ makeSetValue('canvas.canvasSharedPtr', 8, 'pthread_ptr', 'i32') }}};
    }
#endif

    var threadParams = {
      startRoutine,
      pthread_ptr,
      arg,
#if OFFSCREENCANVAS_SUPPORT
      moduleCanvasId,
      offscreenCanvases,
#endif
      transferList,
    };

    if (ENVIRONMENT_IS_PTHREAD) {
      // The prepopulated pool of web workers that can host pthreads is stored
      // in the main JS thread. Therefore if a pthread is attempting to spawn a
      // new thread, the thread creation must be deferred to the main JS thread.
      threadParams.cmd = 'spawnThread';
      postMessage(threadParams, transferList);
      // When we defer thread creation this way, we have no way to detect thread
      // creation synchronously today, so we have to assume success and return 0.
      return 0;
    }

    // We are the main thread, so we have the pthread warmup pool in this
    // thread and can fire off JS thread creation directly ourselves.
    return spawnThread(threadParams);
  },

  emscripten_check_blocking_allowed__deps: ['$warnOnce'],
  emscripten_check_blocking_allowed: function() {
#if ASSERTIONS || IN_TEST_HARNESS || !MINIMAL_RUNTIME || !ALLOW_BLOCKING_ON_MAIN_THREAD
#if ENVIRONMENT_MAY_BE_NODE
    if (ENVIRONMENT_IS_NODE) return;
#endif

    if (ENVIRONMENT_IS_WORKER) return; // Blocking in a worker/pthread is fine.

    warnOnce('Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread');
#if !ALLOW_BLOCKING_ON_MAIN_THREAD
    abort('Blocking on the main thread is not allowed by default. See https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread');
#endif

#endif
  },

  __pthread_kill_js__deps: ['emscripten_main_browser_thread_id'],
  __pthread_kill_js: function(thread, signal) {
    if (signal === {{{ cDefine('SIGCANCEL') }}}) { // Used by pthread_cancel in musl
      if (!ENVIRONMENT_IS_PTHREAD) cancelThread(thread);
      else postMessage({ 'cmd': 'cancelThread', 'thread': thread });
    } else {
      if (!ENVIRONMENT_IS_PTHREAD) killThread(thread);
      else postMessage({ 'cmd': 'killThread', 'thread': thread });
    }
    return 0;
  },

  // This function is call by a pthread to signal that exit() was called and
  // that the entire process should exit.
  // This function is always called from a pthread, but is executed on the
  // main thread due the __proxy attribute.
  $exitOnMainThread__deps: ['exit',
#if !MINIMAL_RUNTIME
    '$handleException',
#endif
  ],
  $exitOnMainThread__proxy: 'async',
  $exitOnMainThread: function(returnCode) {
#if PTHREADS_DEBUG
    err('exitOnMainThread');
#endif
#if MINIMAL_RUNTIME
    _exit(returnCode);
#else
    try {
      _exit(returnCode);
    } catch (e) {
      handleException(e);
    }
#endif
  },

  emscripten_proxy_to_main_thread_js__deps: ['$withStackSave', 'emscripten_run_in_main_runtime_thread_js'],
  emscripten_proxy_to_main_thread_js__docs: '/** @type{function(number, (number|boolean), ...(number|boolean))} */',
  emscripten_proxy_to_main_thread_js: function(index, sync) {
    // Additional arguments are passed after those two, which are the actual
    // function arguments.
    // The serialization buffer contains the number of call params, and then
    // all the args here.
    // We also pass 'sync' to C separately, since C needs to look at it.
    var numCallArgs = arguments.length - 2;
    var outerArgs = arguments;
#if ASSERTIONS
    if (numCallArgs > {{{ cDefine('EM_QUEUED_JS_CALL_MAX_ARGS') }}}-1) throw 'emscripten_proxy_to_main_thread_js: Too many arguments ' + numCallArgs + ' to proxied function idx=' + index + ', maximum supported is ' + ({{{ cDefine('EM_QUEUED_JS_CALL_MAX_ARGS') }}}-1) + '!';
#endif
    // Allocate a buffer, which will be copied by the C code.
    return withStackSave(() => {
      // First passed parameter specifies the number of arguments to the function.
      // When BigInt support is enabled, we must handle types in a more complex
      // way, detecting at runtime if a value is a BigInt or not (as we have no
      // type info here). To do that, add a "prefix" before each value that
      // indicates if it is a BigInt, which effectively doubles the number of
      // values we serialize for proxying. TODO: pack this?
      var serializedNumCallArgs = numCallArgs {{{ WASM_BIGINT ? "* 2" : "" }}};
      var args = stackAlloc(serializedNumCallArgs * 8);
      var b = args >> 3;
      for (var i = 0; i < numCallArgs; i++) {
        var arg = outerArgs[2 + i];
#if WASM_BIGINT
        if (typeof arg == 'bigint') {
          // The prefix is non-zero to indicate a bigint.
          HEAP64[b + 2*i] = 1n;
          HEAP64[b + 2*i + 1] = arg;
        } else {
          // The prefix is zero to indicate a JS Number.
          HEAP64[b + 2*i] = 0n;
          HEAPF64[b + 2*i + 1] = arg;
        }
#else
        HEAPF64[b + i] = arg;
#endif
      }
      return _emscripten_run_in_main_runtime_thread_js(index, serializedNumCallArgs, args, sync);
    });
  },

  emscripten_receive_on_main_thread_js_callArgs: '=[]',

  emscripten_receive_on_main_thread_js__deps: [
    'emscripten_proxy_to_main_thread_js',
    'emscripten_receive_on_main_thread_js_callArgs'],
  emscripten_receive_on_main_thread_js: function(index, numCallArgs, args) {
#if WASM_BIGINT
    numCallArgs /= 2;
#endif
    _emscripten_receive_on_main_thread_js_callArgs.length = numCallArgs;
    var b = args >> 3;
    for (var i = 0; i < numCallArgs; i++) {
#if WASM_BIGINT
      if (HEAP64[b + 2*i]) {
        // It's a BigInt.
        _emscripten_receive_on_main_thread_js_callArgs[i] = HEAP64[b + 2*i + 1];
      } else {
        // It's a Number.
        _emscripten_receive_on_main_thread_js_callArgs[i] = HEAPF64[b + 2*i + 1];
      }
#else
      _emscripten_receive_on_main_thread_js_callArgs[i] = HEAPF64[b + i];
#endif
    }
    // Proxied JS library funcs are encoded as positive values, and
    // EM_ASMs as negative values (see include_asm_consts)
    var isEmAsmConst = index < 0;
    var func = !isEmAsmConst ? proxiedFunctionTable[index] : ASM_CONSTS[-index - 1];
#if ASSERTIONS
    assert(func.length == numCallArgs, 'Call args mismatch in emscripten_receive_on_main_thread_js');
#endif
    return func.apply(null, _emscripten_receive_on_main_thread_js_callArgs);
  },

  // TODO(sbc): Do we really need this to be dynamically settable from JS like this?
  // See https://github.com/emscripten-core/emscripten/issues/15101.
  _emscripten_default_pthread_stack_size: function() {
    return {{{ DEFAULT_PTHREAD_STACK_SIZE }}};
  },

#if STACK_OVERFLOW_CHECK >= 2 && MAIN_MODULE
  $establishStackSpace__deps: ['$setDylinkStackLimits'],
#endif
  $establishStackSpace__internal: true,
  $establishStackSpace: function() {
    var pthread_ptr = _pthread_self();
    var stackTop = {{{ makeGetValue('pthread_ptr', C_STRUCTS.pthread.stack, 'i32') }}};
    var stackSize = {{{ makeGetValue('pthread_ptr', C_STRUCTS.pthread.stack_size, 'i32') }}};
    var stackMax = stackTop - stackSize;
#if PTHREADS_DEBUG
    err('establishStackSpace: ' + ptrToString(stackTop) + ' -> ' + ptrToString(stackMax));
#endif
#if ASSERTIONS
    assert(stackTop != 0);
    assert(stackMax != 0);
    assert(stackTop > stackMax, 'stackTop must be higher then stackMax');
#endif
    // Set stack limits used by `emscripten/stack.h` function.  These limits are
    // cached in wasm-side globals to make checks as fast as possible.
    _emscripten_stack_set_limits(stackTop, stackMax);
#if STACK_OVERFLOW_CHECK >= 2
    // Set stack limits used by binaryen's `StackCheck` pass.
    // TODO(sbc): Can this be combined with the above.
    ___set_stack_limits(stackTop, stackMax);
#if MAIN_MODULE
    // With dynamic linking we could have any number of pre-loaded libraries
    // that each need to have their stack limits set.
    setDylinkStackLimits(stackTop, stackMax);
#endif
#endif

    // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
    stackRestore(stackTop);

#if STACK_OVERFLOW_CHECK
    // Write the stack cookie last, after we have set up the proper bounds and
    // current position of the stack.
    writeStackCookie();
#endif
  },

  $invokeEntryPoint__deps: ['_emscripten_thread_exit'],
  $invokeEntryPoint: function(ptr, arg) {
#if PTHREADS_DEBUG
    err('invokeEntryPoint: ' + ptrToString(ptr));
#endif
#if MAIN_MODULE
    // Before we call the thread entry point, make sure any shared libraries
    // have been loaded on this there.  Otherwise our table migth be not be
    // in sync and might not contain the function pointer `ptr` at all.
    __emscripten_thread_sync_code();
#endif
    // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
    // Native codebases sometimes spawn threads with other thread entry point
    // signatures, such as void ThreadMain(void *arg), void *ThreadMain(), or
    // void ThreadMain().  That is not acceptable per C/C++ specification, but
    // x86 compiler ABI extensions enable that to work. If you find the
    // following line to crash, either change the signature to "proper" void
    // *ThreadMain(void *arg) form, or try linking with the Emscripten linker
    // flag -sEMULATE_FUNCTION_POINTER_CASTS to add in emulation for this x86
    // ABI extension.
    var result = {{{ makeDynCall('ii', 'ptr') }}}(arg);
#if STACK_OVERFLOW_CHECK
    checkStackCookie();
#endif
#if MINIMAL_RUNTIME
    // In MINIMAL_RUNTIME the noExitRuntime concept does not apply to
    // pthreads. To exit a pthread with live runtime, use the function
    // emscripten_unwind_to_js_event_loop() in the pthread body.
    __emscripten_thread_exit(result);
#else
    if (keepRuntimeAlive()) {
      PThread.setExitStatus(result);
    } else {
      __emscripten_thread_exit(result);
    }
#endif
  },

  $executeNotifiedProxyingQueue: function(queue) {
    // Set the notification state to processing.
    Atomics.store(HEAP32, queue >> 2, {{{ cDefine('NOTIFICATION_RECEIVED') }}});
    // Only execute the queue if we have a live pthread runtime. We
    // implement pthread_self to return 0 if there is no live runtime.
    // TODO: Use `callUserCallback` to correctly handle unwinds, etc. once
    //       `runtimeExited` is correctly unset on workers.
    if (_pthread_self()) {
      __emscripten_proxy_execute_task_queue(queue);
    }
    // Set the notification state to none as long as a new notification has not
    // been sent while we were processing.
    Atomics.compareExchange(HEAP32, queue >> 2,
                            {{{ cDefine('NOTIFICATION_RECEIVED') }}},
                            {{{ cDefine('NOTIFICATION_NONE') }}});
  },

  _emscripten_notify_task_queue__deps: ['$executeNotifiedProxyingQueue'],
  _emscripten_notify_task_queue: function(targetThreadId, currThreadId, mainThreadId, queue) {
    if (targetThreadId == currThreadId) {
      setTimeout(() => executeNotifiedProxyingQueue(queue));
    } else if (ENVIRONMENT_IS_PTHREAD) {
      postMessage({'targetThread' : targetThreadId, 'cmd' : 'processProxyingQueue', 'queue' : queue});
    } else {
      var worker = PThread.pthreads[targetThreadId];
      if (!worker) {
#if ASSERTIONS
        err('Cannot send message to thread with ID ' + targetThreadId + ', unknown thread ID!');
#endif
        return /*0*/;
      }
      worker.postMessage({'cmd' : 'processProxyingQueue', 'queue': queue});
    }
    return 1;
  }
};

autoAddDeps(LibraryPThread, '$PThread');
mergeInto(LibraryManager.library, LibraryPThread);
