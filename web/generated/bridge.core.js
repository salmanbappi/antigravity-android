(function(){
/**
 * core/namespace.js - bridge.core bundle scope.
 *
 * Runs first in the bridge.core.js IIFE. Declares the shared scope every other
 * core fragment attaches to: `global`, `CONFIG`, `VERSION`, `warn`, plus the
 * idempotency guard. Window globals stay compatible with the original
 * (`window.__agBridgeCore` is the public API, `window.__AG_BRIDGE_CORE__` the
 * guard).
 */
'use strict';

var AG = (window.__agCore = window.__agCore || {});

if (window.__AG_BRIDGE_CORE__) return;
window.__AG_BRIDGE_CORE__ = true;

var global = window;
var VERSION = '1.0.0';

// Live config: filled by config.js, then kept in sync by csrf.js/endpoints.js.
var CONFIG = window.__APP_CONFIG__ || {};

function warn(where, err) {
  try {
    console.warn('[AGY bridge.core] ' + where + ':', err && err.message ? err.message : err);
  } catch (e) {}
}

/**
 * core/polyfills-process.js - window.process polyfill.
 *
 * main.js assumes an Electron-ish `process`. Provide a POSIX-shaped stub
 * without clobbering a real one.
 */
try {
  if (!window.process || typeof window.process !== 'object') window.process = {};
  var p = window.process;
  if (!p.platform) p.platform = 'linux';
  if (!p.arch) p.arch = 'arm64';
  if (!p.type) p.type = 'renderer';
  p.browser = p.browser !== undefined ? p.browser : true;
  if (!p.env || typeof p.env !== 'object') p.env = {};
  if (!p.versions || typeof p.versions !== 'object') p.versions = {};
  if (typeof p.cwd !== 'function') p.cwd = function () { return CONFIG.workspaceRoot || '/'; };
  if (typeof p.nextTick !== 'function') {
    p.nextTick = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (typeof queueMicrotask === 'function') queueMicrotask(function () { cb.apply(null, args); });
      else Promise.resolve().then(function () { cb.apply(null, args); });
    };
  }
} catch (e) { warn('process polyfill', e); }

/**
 * core/config.js - window.__APP_CONFIG__ fill.
 *
 * Fill only missing keys, then publish the merged object back and rebind
 * CONFIG so later fragments see the resolved values.
 */
var appConfig = {
  productName: 'Antigravity',
  appName: 'AGY',
  appVersion: VERSION,
  version: VERSION,
  isStandalone: true,
  platform: 'android',
  arch: 'arm64',
  enginePort: null,
  engineReady: false,
  apiPrefix: '',
  csrfToken: '',
  workspaceRoot: (CONFIG.workspaceRoot || (window.process && window.process.env && window.process.env.HOME) || '/storage/emulated/0'),
  activeCascadeId: null,
  devMode: false
};

try {
  var injected = window.__APP_CONFIG__ || {};
  for (var k in injected) {
    if (Object.prototype.hasOwnProperty.call(injected, k)) appConfig[k] = injected[k];
  }
  window.__APP_CONFIG__ = appConfig;
  CONFIG = appConfig;
} catch (e) { warn('__APP_CONFIG__', e); }

/**
 * core/csrf.js - CSRF token resolution and cookie sync.
 *
 * Sources (first hit wins): explicit global, meta tag, generated fallback.
 * Publishes `csrfToken`/`csrf_token` cookies that main.js and native read.
 */
function readCsrf() {
  try {
    if (window.__AG_CSRF__) return String(window.__AG_CSRF__);
    var m = document.querySelector('meta[name="csrf-token"], meta[name="csrfToken"]');
    if (m && m.getAttribute('content')) return m.getAttribute('content');
  } catch (e) {}
  return CONFIG.csrfToken || 'agy-standalone-token';
}

function syncCsrf() {
  var token = readCsrf();
  CONFIG.csrfToken = token;
  CONFIG.csrf_token = token;
  try {
    if (document && document.cookie !== undefined) {
      document.cookie = 'csrfToken=' + token + '; path=/; SameSite=Lax';
      document.cookie = 'csrf_token=' + token + '; path=/; SameSite=Lax';
    }
  } catch (e) {}
  return token;
}

syncCsrf();

/**
 * core/endpoints.js - endpoint discovery + core origin resolution.
 *
 * Endpoints come from window.__AG_ENDPOINTS__ or the ?endpoints= query param.
 * `baseOrigin()` prefers a full injected URL, then a bare port mapped to
 * https. Also owns the CSRF header/query helpers shared with fetch-rewrite.
 */
function parseEndpointSpec(raw) {
  var out = {};
  if (!raw) return out;
  if (typeof raw === 'object') {
    for (var k in raw) { if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = String(raw[k]); }
    return out;
  }
  var s = String(raw).trim();
  if (!s) return out;
  // base64(JSON) or raw JSON
  if (s.charAt(0) === '{') {
    try { return parseEndpointSpec(JSON.parse(s)); } catch (e) {}
  }
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0) {
    try {
      var decoded = global.atob ? global.atob(s) : '';
      if (decoded && decoded.charAt(0) === '{') return parseEndpointSpec(JSON.parse(decoded));
    } catch (e) {}
  }
  // k=v,k2=v2  or k=v&k2=v2
  s.split(/[&,]/).forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i > 0) {
      var k = decodeURIComponent(pair.slice(0, i).trim());
      var v = decodeURIComponent(pair.slice(i + 1).trim());
      if (k) out[k] = v;
    }
  });
  return out;
}

var ENDPOINTS = {};
try {
  ENDPOINTS = parseEndpointSpec(global.__AG_ENDPOINTS__);
  if (global.location && global.location.search) {
    var qp = new URLSearchParams(global.location.search);
    var q = qp.get('endpoints') || qp.get('ag_endpoints');
    if (q) {
      var fromQuery = parseEndpointSpec(q);
      for (var qk in fromQuery) { if (Object.prototype.hasOwnProperty.call(fromQuery, qk)) ENDPOINTS[qk] = fromQuery[qk]; }
    }
    var port = qp.get('port') || qp.get('enginePort');
    if (port) { ENDPOINTS.core_http = 'http://127.0.0.1:' + port; ENDPOINTS.enginePort = port; }
  }
} catch (e) { warn('endpoint parse', e); }
global.__AG_ENDPOINTS__ = ENDPOINTS;

function endpoint(name) {
  if (!name) return null;
  if (ENDPOINTS[name]) return ENDPOINTS[name];
  if (name === 'core' || name === 'core_http' || name === 'engine') return baseOrigin();
  return null;
}

function setEndpoint(name, value) {
  if (!name || value === undefined || value === null) return;
  ENDPOINTS[name] = String(value);
  global.__AG_ENDPOINTS__ = ENDPOINTS;
  return ENDPOINTS[name];
}

// The base origin of the core server. Prefer full injected URLs (the core
// serves ConnectRPC over TLS) over a bare port, which must map to https.
function baseOrigin() {
  if (CONFIG.engineBaseUrl) return String(CONFIG.engineBaseUrl).replace(/\/$/, '');
  if (ENDPOINTS.core) return String(ENDPOINTS.core).replace(/\/$/, '');
  if (ENDPOINTS.core_https) return String(ENDPOINTS.core_https).replace(/\/$/, '');
  if (CONFIG.apiPrefix) return String(CONFIG.apiPrefix).replace(/\/$/, '');
  if (ENDPOINTS.core_http) return String(ENDPOINTS.core_http).replace(/\/$/, '');
  if (CONFIG.enginePort) return 'https://127.0.0.1:' + CONFIG.enginePort;
  if (ENDPOINTS.enginePort) return 'https://127.0.0.1:' + ENDPOINTS.enginePort;
  return '';
}

function coreBase() {
  var p = (CONFIG.enginePort || ENDPOINTS.enginePort || (global.__APP_CONFIG__ && global.__APP_CONFIG__.enginePort) || (global.__AG_ENDPOINTS__ && global.__AG_ENDPOINTS__.enginePort) || 45157);
  return (baseOrigin() || ('https://127.0.0.1:' + p)).replace(/\/$/, '');
}

function ensureCsrf(headers) {
  try {
    if (headers && typeof headers.set === 'function'
        && typeof headers.has === 'function'
        && !headers.has('x-codeium-csrf-token')) {
      headers.set('x-codeium-csrf-token', syncCsrf());
    }
  } catch (e) {}
  return headers;
}

function appendCsrfQuery(url) {
  try {
    if (url.indexOf('csrf_token=') === -1) {
      url += (url.indexOf('?') === -1 ? '?' : '&')
          + 'csrf_token=' + encodeURIComponent(syncCsrf());
    }
  } catch (e) {}
  return url;
}

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

/**
 * core/public-api.js - expose window.__agBridgeCore.
 *
 * Dead entries listed in docs/DEADCODE.md are not ported.
 */
var api = {
  version: VERSION,
  config: CONFIG,
  endpoints: ENDPOINTS,
  endpoint: endpoint,
  setEndpoint: setEndpoint,
  baseOrigin: baseOrigin,
  syncCsrf: syncCsrf,
  parseEndpointSpec: parseEndpointSpec
};

window.__agBridgeCore = api;

try { console.log('[AGY bridge.core] ready (endpoints: ' + Object.keys(ENDPOINTS).length + ')'); } catch (e) {}


})();
