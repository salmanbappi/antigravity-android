/**
 * core/fetch-rewrite.js - file:// WebView -> core origin fetch rewrite.
 *
 * The WebView loads from file:///android_asset/web/, so main.js builds its
 * transport from window.location.origin ("file://") and the Connect/grpc-web
 * transport then fetches e.g.
 *   file://exa.language_server_pb.languageserverservice/Method
 * which the WebView rejects: URL scheme "file" is not supported.
 *
 * Rewrite file:// or relative ConnectRPC URLs onto the core origin, preserving
 * method/headers/body and attaching the CSRF token. Idempotent and a no-op for
 * non-RPC / already-absolute http(s) URLs.
 *
 * The original periodic HEAD ping is not ported (it referenced an undefined
 * helper; see docs/DEADCODE.md).
 */
var RPC_MARKERS = ['exa.language_server_pb.', 'exa.host_bridge_pb.', '/exa.'];

// RPC path (no leading slash) when `url` is a file:// or relative ConnectRPC
// URL; null for anything else (http(s), blob, data, static assets).
function rpcPathFrom(url) {
  if (!url) return null;
  var s = String(url);
  if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null' && s.startsWith(window.location.origin)) {
    s = s.slice(window.location.origin.length);
  } else if (/^(https?|blob|data|wss?|chrome-extension):/i.test(s)) {
    return null;
  }
  var best = -1;
  for (var i = 0; i < RPC_MARKERS.length; i++) {
    var at = s.indexOf(RPC_MARKERS[i]);
    if (at >= 0 && (best === -1 || at < best)) best = at;
  }
  if (best === -1) return null;
  return s.slice(best).replace(/^\/+/, '') || null;
}

var activeStreams = typeof Set === 'function' ? new Set() : null;

// Server-streaming state RPCs that stay open indefinitely and must be
// force-reset on host resume / reconnect if the WebView stalled them.
// Excludes unary RPCs (never abort mutations/queries) and mic audio capture.
function isStreamingRpcPath(path) {
  if (!path) return false;
  var s = String(path).split('?')[0];
  if (/\/StreamAudioTranscription$/i.test(s)) return false;
  return /\/Stream[A-Z][A-Za-z0-9_]*$/.test(s);
}

function makeResumeAbortError(reason) {
  var msg = 'AGY stream reset (' + (reason || 'host-resume') + ')';
  if (typeof DOMException === 'function') {
    try { return new DOMException(msg, 'AbortError'); } catch (e) {}
  }
  var err = new Error(msg);
  err.name = 'AbortError';
  return err;
}

function resetActiveStreams(reason, minAgeMs) {
  if (!activeStreams || activeStreams.size === 0) return 0;
  var now = Date.now();
  var grace = typeof minAgeMs === 'number' ? minAgeMs : 1500;
  var targets = [];
  activeStreams.forEach(function (entry) {
    if (!entry.cleaned && (now - entry.startedAt) >= grace) {
      targets.push(entry);
    }
  });
  for (var i = 0; i < targets.length; i++) {
    try {
      targets[i].forceReset(reason);
    } catch (e) {
      warn('stream reset error', e);
    }
  }
  return targets.length;
}

function installFetchRewrite() {
  if (global.__AG_FETCH_REWRITE__ || typeof global.fetch !== 'function') return;
  var origFetch = global.fetch.bind(global);

  function isAbortedError(opts, err) {
    if (opts && opts.signal && opts.signal.aborted) return true;
    return !!(err && (err.name === 'AbortError' || err.code === 20));
  }

  function fetchWithStartupRetry(u, opts, retries, attempt) {
    var step = attempt || 0;
    return origFetch(u, opts).catch(function (err) {
      if (isAbortedError(opts, err) || retries <= 0) {
        throw err;
      }
      var delayMs = Math.min(800, 120 + step * 80);
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (opts && opts.signal && opts.signal.aborted) {
            reject(err);
            return;
          }
          resolve(fetchWithStartupRetry(u, opts, retries - 1, step + 1));
        }, delayMs);
      });
    });
  }

  function fetchTrackedRpc(url, opts, rpcPath) {
    if (!activeStreams || !isStreamingRpcPath(rpcPath)) {
      return fetchWithStartupRetry(url, opts, 30, 0);
    }

    var callerSignal = opts && opts.signal ? opts.signal : null;
    var innerCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    var onCallerAbort = null;
    if (innerCtrl && callerSignal) {
      if (callerSignal.aborted) {
        try { innerCtrl.abort(callerSignal.reason); } catch (e) {}
      } else {
        onCallerAbort = function () {
          try { innerCtrl.abort(callerSignal.reason); } catch (e) {}
        };
        try { callerSignal.addEventListener('abort', onCallerAbort, { once: true }); } catch (e) {}
      }
    }

    var reqOpts = {};
    if (opts) {
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) reqOpts[k] = opts[k];
      }
    }
    if (innerCtrl) {
      reqOpts.signal = innerCtrl.signal;
    }

    var entry = {
      path: rpcPath,
      startedAt: Date.now(),
      controller: innerCtrl,
      callerSignal: callerSignal,
      cleaned: false,
      forceReset: null
    };

    function cleanup() {
      if (entry.cleaned) return;
      entry.cleaned = true;
      activeStreams.delete(entry);
      if (callerSignal && onCallerAbort) {
        try { callerSignal.removeEventListener('abort', onCallerAbort); } catch (e) {}
      }
    }

    entry.forceReset = function (reason) {
      var err = makeResumeAbortError(reason);
      cleanup();
      if (innerCtrl && !innerCtrl.signal.aborted) {
        try { innerCtrl.abort(err); } catch (e) {}
      }
    };

    activeStreams.add(entry);

    return fetchWithStartupRetry(url, reqOpts, 30, 0).then(function (resp) {
      if (
        !resp ||
        !resp.body ||
        typeof resp.body.getReader !== 'function' ||
        typeof ReadableStream !== 'function' ||
        typeof Response !== 'function' ||
        resp.status < 200 ||
        resp.status === 204 ||
        resp.status === 205 ||
        resp.status === 304
      ) {
        cleanup();
        return resp;
      }

      var origReader = resp.body.getReader();
      var streamCtrl = null;
      var closedOrErrored = false;

      var wrappedBody = new ReadableStream({
        start: function (controller) {
          streamCtrl = controller;
        },
        pull: function (controller) {
          return origReader.read().then(function (res) {
            if (closedOrErrored) return;
            if (res.done) {
              closedOrErrored = true;
              cleanup();
              try { controller.close(); } catch (e) {}
              return;
            }
            try { controller.enqueue(res.value); } catch (e) {}
          }, function (err) {
            if (closedOrErrored) return;
            closedOrErrored = true;
            cleanup();
            try { controller.error(err); } catch (e) {}
          });
        },
        cancel: function (reason) {
          closedOrErrored = true;
          cleanup();
          try { return origReader.cancel(reason); } catch (e) {}
        }
      });

      entry.forceReset = function (reason) {
        var err = makeResumeAbortError(reason);
        if (!closedOrErrored) {
          closedOrErrored = true;
          cleanup();
          if (streamCtrl) {
            try { streamCtrl.error(err); } catch (e) {}
          }
        } else {
          cleanup();
        }
        try {
          var cancelP = origReader.cancel(err);
          if (cancelP && typeof cancelP.catch === 'function') {
            cancelP.catch(function () {});
          }
        } catch (e) {}
        if (innerCtrl && !innerCtrl.signal.aborted) {
          try { innerCtrl.abort(err); } catch (e) {}
        }
      };

      if (entry.cleaned) {
        entry.forceReset('aborted-before-body');
      }

      return new Response(wrappedBody, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers
      });
    }, function (err) {
      cleanup();
      throw err;
    });
  }

  global.fetch = function (resource, init) {
    try {
      // Request object: rebuild against the core origin, keep method/body.
      if (resource && typeof resource === 'object' && typeof resource.url === 'string') {
        var rpath = rpcPathFrom(resource.url);
        if (rpath) {
          try {
            var targetUrl = appendCsrfQuery(coreBase() + '/' + rpath);
            var reqMethod = resource.method || (init && init.method) || 'POST';
            var reqHeaders = new Headers(resource.headers || (init && init.headers) || {});
            ensureCsrf(reqHeaders);

            var bodyPromise;
            if (init && init.body !== undefined) {
              bodyPromise = Promise.resolve(init.body);
            } else {
              try {
                bodyPromise = resource.clone().arrayBuffer().then(function (buf) {
                  return buf.byteLength > 0 ? buf : undefined;
                }).catch(function () { return undefined; });
              } catch (e) {
                bodyPromise = Promise.resolve(undefined);
              }
            }

            return bodyPromise.then(function (bodyData) {
              var nextOpts = {
                method: reqMethod,
                headers: reqHeaders,
                body: bodyData,
                credentials: 'omit'
              };
              if (init && init.signal) {
                nextOpts.signal = init.signal;
              } else if (resource.signal) {
                nextOpts.signal = resource.signal;
              }
              return fetchTrackedRpc(targetUrl, nextOpts, rpath);
            });
          } catch (e) { warn('fetch rewrite (Request)', e); }
        }
        return origFetch(resource, init);
      }

      // String URL: the Connect/grpc-web transport's common path.
      if (typeof resource === 'string') {
        var path = rpcPathFrom(resource);
        if (path) {
          var url = appendCsrfQuery(coreBase() + '/' + path);
          var headers = new Headers((init && init.headers) || {});
          ensureCsrf(headers);
          var next = {};
          if (init) {
            for (var k in init) {
              if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
            }
          }
          next.headers = headers;

          return fetchTrackedRpc(url, next, path);
        }
      }
    } catch (e) { warn('fetch rewrite', e); }
    return origFetch(resource, init);
  };
  global.__AG_FETCH_REWRITE__ = true;
}

function installMediaPolyfills() {
  try {
    if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
      var origQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(d) {
        if (d && d.name === 'microphone') {
          return Promise.resolve({ name: 'microphone', state: 'granted', onchange: null });
        }
        return origQ(d);
      };
    }
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      var origG = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = function(c) {
        var cl = c;
        if (c && typeof c === 'object') {
          cl = Object.assign({}, c);
          if (cl.audio && typeof cl.audio === 'object') {
            cl.audio = Object.assign({}, cl.audio);
            delete cl.audio.voiceIsolation;
          }
        }
        return origG(cl).catch(function(err) {
          if (err && (err.name === 'NotReadableError' || err.name === 'OverconstrainedError' || err.name === 'AbortError')) {
            return new Promise(function(res) { setTimeout(res, 180); }).then(function() {
              return origG({ audio: true });
            });
          }
          throw err;
        });
      };
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[AGY_AUDIO] media polyfill init error', e);
  }
}

installFetchRewrite();
installMediaPolyfills();

function installResumeHandler() {
  try {
    if (global.__AG_RESUME_HANDLER__) return;
    global.__AG_RESUME_HANDLER__ = true;
    var lastRecoveryAt = 0;
    var hiddenAt = 0;
    var pendingRecovery = null;
    var dispatchingSynthetic = false;
    var RECOVERY_DEBOUNCE_MS = 1000;

    function isDocumentHidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function triggerStreamRecovery(reason, detail) {
      if (isDocumentHidden()) {
        pendingRecovery = { reason: reason, detail: detail || null };
        return;
      }
      var now = Date.now();
      if (now - lastRecoveryAt < RECOVERY_DEBOUNCE_MS) return;
      lastRecoveryAt = now;
      pendingRecovery = null;
      try {
        var minAgeMs = (detail && detail.wasStopped) ? 500 : 1500;
        var resetCount = resetActiveStreams(reason, minAgeMs);
        dispatchingSynthetic = true;
        try {
          global.dispatchEvent(new Event('focus'));
          if (reason !== 'browser-online') {
            global.dispatchEvent(new Event('online'));
          }
          if (typeof document !== 'undefined') {
            document.dispatchEvent(new Event('visibilitychange'));
          }
        } finally {
          dispatchingSynthetic = false;
        }
        if (typeof CustomEvent === 'function') {
          global.dispatchEvent(new CustomEvent('agy:stream-recover', {
            detail: {
              reason: reason,
              resetCount: resetCount,
              backgroundMs: detail && typeof detail.backgroundMs === 'number' ? detail.backgroundMs : 0,
              wasStopped: !!(detail && detail.wasStopped)
            }
          }));
        }
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[AGY] stream recovery dispatch error', err);
        }
      }
    }

    global.addEventListener('agy:host-resume', function (ev) {
      triggerStreamRecovery('host-resume', ev && ev.detail ? ev.detail : null);
    });
    global.addEventListener('agy:network-online', function (ev) {
      triggerStreamRecovery('network-online', ev && ev.detail ? ev.detail : null);
    });
    global.addEventListener('online', function () {
      if (dispatchingSynthetic) return;
      triggerStreamRecovery('browser-online', null);
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (dispatchingSynthetic) return;
        if (document.visibilityState === 'hidden') {
          hiddenAt = Date.now();
          return;
        }
        if (document.visibilityState === 'visible') {
          var elapsed = hiddenAt > 0 ? (Date.now() - hiddenAt) : 0;
          hiddenAt = 0;
          if (pendingRecovery) {
            var pending = pendingRecovery;
            pendingRecovery = null;
            triggerStreamRecovery(pending.reason, pending.detail);
          } else if (elapsed >= 1500) {
            triggerStreamRecovery('visibility-visible', { backgroundMs: elapsed, wasStopped: false });
          }
        }
      });
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AGY] resume handler install error', e);
    }
  }
}

installResumeHandler();
