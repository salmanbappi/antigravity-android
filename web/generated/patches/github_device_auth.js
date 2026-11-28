(function(){
/**
 * patches/github_device_auth/install.js - Direct local GitHub browser login
 * via OAuth 2.0 Device Flow (RFC 8628) for the GitHub (Local) plugin.
 *
 * Scopes strictly to the GitHub (Local) api_key provider card inside
 * section[aria-label="Accounts"], supports both initial sign-in and
 * multi-account "Add account", preserves manual PAT paste as fallback,
 * and talks exclusively to github.com via AndroidBridge (zero client_secret,
 * zero third-party proxy, zero token logging).
 */
var global = typeof window !== 'undefined' ? window : this;
if (!global.__AG_GITHUB_DEVICE_AUTH_INSTALLED__) {
  global.__AG_GITHUB_DEVICE_AUTH_INSTALLED__ = true;

  var DEFAULT_SCOPE = 'repo read:org gist workflow';
  var DEFAULT_VERIFICATION_URI = 'https://github.com/login/device';
  var BRIDGE_TIMEOUT_MS = 25000;
  var MIN_POLL_INTERVAL_MS = 5000;
  var MAX_NETWORK_ERRORS = 5;

  var reqSeq = 0;
  var sessionSeq = 0;
  var pendingRequests = {};
  var activeSession = null;
  var scanTimer = null;

  var GITHUB_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" style="flex-shrink:0">' +
    '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 ' +
    '0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 ' +
    '1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 ' +
    '0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 ' +
    '1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 ' +
    '3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>' +
    '</svg>';

  function getBridge() {
    var token = global.__AG_NATIVE_BRIDGE_TOKEN__;
    var bridge = global.Android || global.AndroidBridge;
    if (!token || !bridge) return null;
    if (typeof bridge.startGitHubDeviceAuth !== 'function' ||
        typeof bridge.pollGitHubDeviceAuth !== 'function') {
      return null;
    }
    return { bridge: bridge, token: String(token) };
  }

  function installStyles(doc) {
    if (!doc || !doc.querySelector || !doc.createElement) return;
    if (doc.querySelector('style[data-agy="github-device-auth"]')) return;
    try {
      var st = doc.createElement('style');
      st.setAttribute('data-agy', 'github-device-auth');
      st.textContent =
        '.agy-gh-auth{display:flex;flex-direction:column;gap:8px;padding-top:8px;' +
        'border-top:1px solid var(--border,rgba(148,163,184,0.22));}' +
        '.agy-gh-auth-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}' +
        '.agy-gh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;' +
        'min-height:30px;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;' +
        'line-height:1.2;cursor:pointer;border:1px solid var(--border,rgba(148,163,184,0.35));' +
        'background:transparent;color:var(--foreground,inherit);transition:opacity .15s;}' +
        '.agy-gh-btn:disabled{opacity:0.5;cursor:not-allowed;}' +
        '.agy-gh-btn-primary{background:var(--primary,#2563eb);color:var(--primary-foreground,#ffffff);' +
        'border-color:transparent;}' +
        '.agy-gh-panel{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:6px;' +
        'background:var(--muted,rgba(148,163,184,0.12));' +
        'border:1px solid var(--border,rgba(148,163,184,0.28));}' +
        '.agy-gh-title{margin:0;font-size:12px;color:var(--muted-foreground,#94a3b8);line-height:1.4;}' +
        '.agy-gh-code-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}' +
        '.agy-gh-code{display:inline-flex;align-items:center;padding:4px 10px;border-radius:6px;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
        'font-size:18px;font-weight:700;letter-spacing:0.14em;user-select:all;-webkit-user-select:all;' +
        'background:var(--background,rgba(15,23,42,0.55));color:var(--foreground,inherit);' +
        'border:1px solid var(--border,rgba(148,163,184,0.35));}' +
        '.agy-gh-status{margin:0;font-size:12px;color:var(--muted-foreground,#94a3b8);line-height:1.4;}' +
        '.agy-gh-error{margin:0;font-size:12px;color:#ef4444;line-height:1.4;}' +
        '@media (max-width:640px){' +
        '.agy-gh-btn{min-height:32px;padding:6px 12px;font-size:13px;}' +
        '.agy-gh-auth-row > .agy-gh-btn{flex:1 1 auto;}' +
        '}';
      (doc.head || doc.documentElement).appendChild(st);
    } catch (ignored) {}
  }

  global.__agGitHubDeviceAuthCallback = function (reqId, rawJson) {
    var entry = pendingRequests[reqId];
    if (!entry) return;
    delete pendingRequests[reqId];
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    var parsed;
    if (rawJson && typeof rawJson === 'object') {
      parsed = rawJson;
    } else {
      try {
        parsed = JSON.parse(String(rawJson || '{}'));
      } catch (e) {
        parsed = { ok: false, status: 'network_error', error: 'parse_error', error_description: 'Invalid response from bridge' };
      }
    }
    entry.resolve(parsed);
  };

  function callNativeStart(scope) {
    return new Promise(function (resolve) {
      var env = getBridge();
      if (!env) {
        resolve({ ok: false, error: 'bridge_unavailable', error_description: 'Native GitHub login bridge unavailable' });
        return;
      }
      var reqId = 'gh_start_' + (++reqSeq);
      var timer = setTimeout(function () {
        if (pendingRequests[reqId]) {
          delete pendingRequests[reqId];
          resolve({ ok: false, error: 'timeout', error_description: 'Timed out contacting GitHub' });
        }
      }, BRIDGE_TIMEOUT_MS);
      pendingRequests[reqId] = { resolve: resolve, timer: timer };
      try {
        env.bridge.startGitHubDeviceAuth(env.token, reqId, scope || DEFAULT_SCOPE);
      } catch (e) {
        if (pendingRequests[reqId]) {
          clearTimeout(timer);
          delete pendingRequests[reqId];
          resolve({ ok: false, error: 'bridge_error', error_description: 'Failed to start GitHub sign-in' });
        }
      }
    });
  }

  function callNativePoll(deviceCode) {
    return new Promise(function (resolve) {
      var env = getBridge();
      if (!env) {
        resolve({ ok: false, status: 'network_error', error: 'bridge_unavailable', error_description: 'Native bridge unavailable' });
        return;
      }
      var reqId = 'gh_poll_' + (++reqSeq);
      var timer = setTimeout(function () {
        if (pendingRequests[reqId]) {
          delete pendingRequests[reqId];
          resolve({ ok: false, status: 'network_error', error: 'timeout', error_description: 'Poll timed out' });
        }
      }, BRIDGE_TIMEOUT_MS);
      pendingRequests[reqId] = { resolve: resolve, timer: timer };
      try {
        env.bridge.pollGitHubDeviceAuth(env.token, reqId, deviceCode);
      } catch (e) {
        if (pendingRequests[reqId]) {
          clearTimeout(timer);
          delete pendingRequests[reqId];
          resolve({ ok: false, status: 'network_error', error: 'bridge_error', error_description: 'Poll bridge call failed' });
        }
      }
    });
  }

  function copyCode(code) {
    var ok = false;
    var env = getBridge();
    if (env && typeof env.bridge.copyGitHubDeviceCode === 'function') {
      try {
        ok = Boolean(env.bridge.copyGitHubDeviceCode(env.token, String(code)));
      } catch (ignored) {}
    }
    if (!ok && typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        navigator.clipboard.writeText(String(code));
        ok = true;
      } catch (ignored) {}
    }
    return ok;
  }

  function openDevicePage(verificationUri) {
    var uri = (verificationUri && String(verificationUri).indexOf(DEFAULT_VERIFICATION_URI) === 0)
      ? String(verificationUri)
      : DEFAULT_VERIFICATION_URI;
    var env = getBridge();
    if (env && typeof env.bridge.openGitHubDevicePage === 'function') {
      try {
        if (env.bridge.openGitHubDevicePage(env.token, uri)) {
          return true;
        }
      } catch (ignored) {}
    }
    if (typeof global.open === 'function') {
      try {
        global.open(uri, '_blank', 'noopener,noreferrer');
        return true;
      } catch (ignored) {}
    }
    return false;
  }

  function getText(el) {
    return el && typeof el.textContent === 'string' ? el.textContent.trim() : '';
  }

  function isInsideOurUi(el) {
    if (!el) return false;
    if (typeof el.closest === 'function') {
      return Boolean(el.closest('[data-agy-github-auth]'));
    }
    var cur = el;
    while (cur) {
      if (cur.getAttribute && cur.getAttribute('data-agy-github-auth')) return true;
      cur = cur.parentElement || cur.parent || null;
    }
    return false;
  }

  function isGitHubLocalCard(card) {
    if (!card || !card.querySelector || !card.querySelectorAll) return false;
    if (isInsideOurUi(card)) return false;

    var spans = card.querySelectorAll('span');
    var isProviderGithub = false;
    var isApiKeyBadge = false;
    for (var i = 0; i < spans.length; i++) {
      if (isInsideOurUi(spans[i])) continue;
      var txt = getText(spans[i]);
      if (txt === 'github') {
        isProviderGithub = true;
      } else if (txt.toLowerCase() === 'api key') {
        isApiKeyBadge = true;
      }
    }
    if (!isProviderGithub || !isApiKeyBadge) return false;

    var hasTokensLink = Boolean(card.querySelector('a[href*="github.com/settings/tokens"]'));
    var hasGitHubInput = Boolean(
      card.querySelector('input[aria-label="Secret for github"]') ||
      card.querySelector('input[aria-label="Secret for a new github account"]')
    );
    var hasGitHubRoute = Boolean(
      global.location &&
      typeof global.location.pathname === 'string' &&
      /\/customizations\/plugins\/github(?:\/|$)/i.test(global.location.pathname)
    );
    return hasTokensLink || hasGitHubInput || hasGitHubRoute;
  }

  function findGitHubLocalCard() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    var sections = document.querySelectorAll('section[aria-label="Accounts"]');
    for (var s = 0; s < sections.length; s++) {
      var cards = sections[s].querySelectorAll('div');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var cls = String(c.className || '');
        if (cls.indexOf('rounded-md') < 0 || cls.indexOf('border') < 0) continue;
        if (isGitHubLocalCard(c)) {
          return c;
        }
      }
    }
    return null;
  }

  function hasSignedInAccounts(card) {
    if (!card || !card.querySelector) return false;
    return Boolean(card.querySelector('ul[aria-label="Signed-in accounts"]'));
  }

  function findNativeAddAccountButton(card) {
    if (!card || !card.querySelectorAll) return null;
    var btns = card.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (isInsideOurUi(btns[i])) continue;
      if (getText(btns[i]) === 'Add account') {
        return btns[i];
      }
    }
    return null;
  }

  function isCardDisabled(card) {
    if (!card) return true;
    var input = card.querySelector('input[aria-label="Secret for github"]') ||
      card.querySelector('input[aria-label="Secret for a new github account"]');
    if (input && (input.disabled || (input.hasAttribute && input.hasAttribute('disabled')))) {
      return true;
    }
    var addBtn = findNativeAddAccountButton(card);
    if (addBtn && (addBtn.disabled || (addBtn.hasAttribute && addBtn.hasAttribute('disabled')))) {
      return true;
    }
    var section = typeof card.closest === 'function' ? card.closest('section[aria-label="Accounts"]') : null;
    if (section && getText(section).indexOf('Enable this plugin to manage its accounts.') >= 0) {
      return true;
    }
    return false;
  }

  function setReactInputValue(input, val) {
    var proto = typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null;
    var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && typeof desc.set === 'function') {
      desc.set.call(input, val);
    } else {
      input.value = val;
    }
    try {
      if (input._valueTracker && typeof input._valueTracker.setValue === 'function') {
        input._valueTracker.setValue('');
      }
    } catch (ignored) {}
    var EventCtor = typeof global.Event === 'function' ? global.Event : null;
    if (EventCtor) {
      input.dispatchEvent(new EventCtor('input', { bubbles: true }));
      input.dispatchEvent(new EventCtor('change', { bubbles: true }));
    } else {
      input.dispatchEvent({ type: 'input', bubbles: true });
      input.dispatchEvent({ type: 'change', bubbles: true });
    }
  }

  function findSiblingSubmitButton(input, expectedLabel) {
    var parent = input ? (input.parentElement || input.parent) : null;
    if (!parent || !parent.querySelectorAll) return null;
    var btns = parent.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var label = getText(btns[i]);
      if (expectedLabel && label === expectedLabel) return btns[i];
    }
    for (var j = 0; j < btns.length; j++) {
      var fallback = getText(btns[j]);
      if (fallback === 'Sign in' || fallback === 'Add') return btns[j];
    }
    return null;
  }

  function waitForCondition(checkFn, maxAttempts, intervalMs, done) {
    var attempts = 0;
    function step() {
      var result = checkFn();
      if (result) {
        done(result);
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        done(null);
        return;
      }
      setTimeout(step, intervalMs);
    }
    step();
  }

  function fillInputAndSubmit(input, expectedBtnLabel, accessToken, callback) {
    setReactInputValue(input, accessToken);
    // Defer by one macrotask so React 18 createRoot flushes the async onChange
    // microtask and commits the updated onClick closure even if the input was
    // previously non-empty (button already enabled with a stale value).
    setTimeout(function () {
      waitForCondition(function () {
        var btn = findSiblingSubmitButton(input, expectedBtnLabel);
        if (!btn) return null;
        var isDis = Boolean(btn.disabled || (btn.hasAttribute && btn.hasAttribute('disabled')));
        return isDis ? null : btn;
      }, 30, 25, function (btn) {
        if (!btn) {
          callback(false);
          return;
        }
        btn.click();
        callback(true);
      });
    }, 25);
  }

  function submitViaRpcFallback(accessToken, addAccount, callback) {
    if (typeof global.fetch !== 'function') {
      callback(false, 'Unable to submit GitHub credentials automatically.');
      return;
    }
    try {
      global.fetch('/exa.language_server_pb.LanguageServerService/SignInPluginAuthProvider', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1'
        },
        body: JSON.stringify({
          plugin: 'github',
          provider: 'github',
          secret: accessToken,
          addAccount: Boolean(addAccount)
        })
      }).then(function (resp) {
        if (resp && resp.ok) {
          try {
            var EventCtor = typeof global.Event === 'function' ? global.Event : null;
            if (typeof global.dispatchEvent === 'function') {
              global.dispatchEvent(EventCtor ? new EventCtor('focus') : { type: 'focus' });
            }
          } catch (ignored) {}
          callback(true, '');
        } else {
          callback(false, 'Failed to save GitHub credentials.');
        }
      }, function () {
        callback(false, 'Failed to save GitHub credentials.');
      });
    } catch (e) {
      callback(false, 'Failed to save GitHub credentials.');
    }
  }

  function submitAccessToken(accessToken, sess) {
    var card = findGitHubLocalCard();
    var addAccount = Boolean(sess && sess.addAccount);
    if (card && hasSignedInAccounts(card)) {
      addAccount = true;
    }

    function finishSubmission(ok, errMsg) {
      if (!activeSession || activeSession.id !== sess.id) return;
      if (ok) {
        activeSession = null;
        renderAll();
      } else {
        sess.status = 'error';
        sess.error = errMsg || 'Signed in with GitHub, but failed to save token.';
        renderAll();
      }
    }

    if (!card) {
      submitViaRpcFallback(accessToken, addAccount, finishSubmission);
      return;
    }

    if (addAccount) {
      var existingAddInput = card.querySelector('input[aria-label="Secret for a new github account"]');
      if (existingAddInput) {
        fillInputAndSubmit(existingAddInput, 'Add', accessToken, function (ok) {
          if (ok) finishSubmission(true, '');
          else submitViaRpcFallback(accessToken, true, finishSubmission);
        });
        return;
      }
      var addBtn = findNativeAddAccountButton(card);
      if (addBtn && !addBtn.disabled) {
        addBtn.click();
        waitForCondition(function () {
          var liveCard = findGitHubLocalCard() || card;
          return liveCard.querySelector('input[aria-label="Secret for a new github account"]');
        }, 40, 25, function (mountedInput) {
          if (!mountedInput) {
            submitViaRpcFallback(accessToken, true, finishSubmission);
            return;
          }
          fillInputAndSubmit(mountedInput, 'Add', accessToken, function (ok) {
            if (ok) finishSubmission(true, '');
            else submitViaRpcFallback(accessToken, true, finishSubmission);
          });
        });
        return;
      }
      submitViaRpcFallback(accessToken, true, finishSubmission);
      return;
    }

    var initInput = card.querySelector('input[aria-label="Secret for github"]');
    if (initInput) {
      fillInputAndSubmit(initInput, 'Sign in', accessToken, function (ok) {
        if (ok) finishSubmission(true, '');
        else submitViaRpcFallback(accessToken, false, finishSubmission);
      });
      return;
    }
    submitViaRpcFallback(accessToken, false, finishSubmission);
  }

  function clearSessionTimer(sess) {
    if (sess && sess.pollTimer) {
      clearTimeout(sess.pollTimer);
      sess.pollTimer = null;
    }
  }

  function cancelActiveSession() {
    if (activeSession) {
      clearSessionTimer(activeSession);
      activeSession.canceled = true;
      activeSession = null;
    }
    renderAll();
  }

  function schedulePoll(sess, delayMs) {
    if (!sess || sess.canceled || !activeSession || activeSession.id !== sess.id) return;
    clearSessionTimer(sess);
    var waitMs = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : sess.intervalMs;
    sess.pollTimer = setTimeout(function () {
      sess.pollTimer = null;
      runPoll(sess);
    }, waitMs);
  }

  function runPoll(sess) {
    if (!sess || sess.canceled || !activeSession || activeSession.id !== sess.id) return;
    if (sess.status !== 'awaiting' || sess.inFlight) return;
    if (Date.now() >= sess.expiresAt) {
      sess.status = 'error';
      sess.error = 'Sign-in code expired. Tap Try again for a new code.';
      renderAll();
      return;
    }

    sess.inFlight = true;
    sess.lastPollAt = Date.now();
    callNativePoll(sess.deviceCode).then(function (res) {
      sess.inFlight = false;
      if (!activeSession || activeSession.id !== sess.id || sess.canceled) return;

      if (res && res.status === 'complete' && res.access_token) {
        clearSessionTimer(sess);
        sess.status = 'submitting';
        sess.error = '';
        renderAll();
        submitAccessToken(String(res.access_token), sess);
        return;
      }

      var errCode = res && res.error ? String(res.error) : '';
      if ((res && res.status === 'pending') || errCode === 'authorization_pending') {
        sess.networkErrors = 0;
        schedulePoll(sess, sess.intervalMs);
        return;
      }

      if ((res && res.status === 'slow_down') || errCode === 'slow_down') {
        sess.networkErrors = 0;
        var nextSec = res && typeof res.interval === 'number' ? res.interval : 0;
        var nextMs = nextSec > 0 ? nextSec * 1000 : (sess.intervalMs + 5000);
        sess.intervalMs = Math.max(sess.intervalMs + 5000, nextMs);
        schedulePoll(sess, sess.intervalMs);
        return;
      }

      if (errCode === 'expired_token') {
        sess.status = 'error';
        sess.error = 'Sign-in code expired. Tap Try again for a new code.';
        renderAll();
        return;
      }

      if (errCode === 'access_denied') {
        sess.status = 'error';
        sess.error = 'GitHub authorization was canceled.';
        renderAll();
        return;
      }

      if (res && res.status === 'network_error') {
        sess.networkErrors = (sess.networkErrors || 0) + 1;
        if (sess.networkErrors <= MAX_NETWORK_ERRORS && Date.now() < sess.expiresAt) {
          schedulePoll(sess, Math.max(sess.intervalMs, 5000));
          return;
        }
        sess.status = 'error';
        sess.error = 'Unable to reach GitHub. Check your connection and try again.';
        renderAll();
        return;
      }

      sess.status = 'error';
      sess.error = (res && res.error_description) || errCode || 'GitHub sign-in failed.';
      renderAll();
    });
  }

  function startFlow(addAccount) {
    if (activeSession) {
      clearSessionTimer(activeSession);
      activeSession.canceled = true;
    }
    var sess = {
      id: ++sessionSeq,
      addAccount: Boolean(addAccount),
      status: 'starting',
      deviceCode: '',
      userCode: '',
      verificationUri: DEFAULT_VERIFICATION_URI,
      expiresAt: 0,
      intervalMs: MIN_POLL_INTERVAL_MS,
      lastPollAt: 0,
      networkErrors: 0,
      copied: false,
      inFlight: false,
      canceled: false,
      pollTimer: null,
      error: ''
    };
    activeSession = sess;
    renderAll();

    callNativeStart(DEFAULT_SCOPE).then(function (res) {
      if (!activeSession || activeSession.id !== sess.id || sess.canceled) return;
      if (!res || !res.ok || !res.device_code || !res.user_code) {
        sess.status = 'error';
        sess.error = (res && res.error_description) || (res && res.error) || 'Failed to start GitHub sign-in.';
        renderAll();
        return;
      }
      sess.deviceCode = String(res.device_code);
      sess.userCode = String(res.user_code);
      sess.verificationUri = (res.verification_uri && String(res.verification_uri).indexOf(DEFAULT_VERIFICATION_URI) === 0)
        ? String(res.verification_uri)
        : DEFAULT_VERIFICATION_URI;
      var expiresSec = typeof res.expires_in === 'number' && res.expires_in > 0 ? res.expires_in : 900;
      var intervalSec = typeof res.interval === 'number' && res.interval > 0 ? res.interval : 5;
      sess.expiresAt = Date.now() + expiresSec * 1000;
      sess.intervalMs = Math.max(MIN_POLL_INTERVAL_MS, intervalSec * 1000);
      sess.copied = copyCode(sess.userCode);
      sess.status = 'awaiting';
      sess.lastPollAt = Date.now();
      renderAll();
      schedulePoll(sess, sess.intervalMs);
    });
  }

  function makeEl(doc, tag, className, text) {
    var el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function buildSignature(hasAccounts, disabled) {
    if (!activeSession) {
      return 'idle|' + (hasAccounts ? '1' : '0') + '|' + (disabled ? '1' : '0');
    }
    return [
      activeSession.id,
      activeSession.status,
      activeSession.userCode,
      activeSession.copied ? '1' : '0',
      activeSession.error,
      hasAccounts ? '1' : '0',
      disabled ? '1' : '0'
    ].join('|');
  }

  function renderIntoCard(card) {
    if (!card || typeof document === 'undefined') return;
    var doc = card.ownerDocument || document;
    var hasAccounts = hasSignedInAccounts(card);
    var disabled = isCardDisabled(card);
    var container = card.querySelector('[data-agy-github-auth="container"]');
    var sig = buildSignature(hasAccounts, disabled);

    if (container && card.lastElementChild && card.lastElementChild !== container) {
      card.appendChild(container);
    }
    if (container && container.getAttribute('data-agy-sig') === sig) {
      return;
    }
    if (!container) {
      container = makeEl(doc, 'div', 'agy-gh-auth');
      container.setAttribute('data-agy-github-auth', 'container');
      card.appendChild(container);
    }
    container.setAttribute('data-agy-sig', sig);
    container.innerHTML = '';

    if (!activeSession) {
      var row = makeEl(doc, 'div', 'agy-gh-auth-row');
      var btn = makeEl(
        doc,
        'button',
        hasAccounts ? 'agy-gh-btn' : 'agy-gh-btn agy-gh-btn-primary'
      );
      btn.type = 'button';
      btn.disabled = disabled;
      btn.setAttribute('data-agy-github-auth', hasAccounts ? 'add-btn' : 'signin-btn');
      btn.innerHTML = GITHUB_ICON_SVG + '<span>' +
        (hasAccounts ? 'Add account with GitHub (Browser)' : 'Sign in with GitHub (Browser)') +
        '</span>';
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        startFlow(hasAccounts);
      });
      row.appendChild(btn);
      container.appendChild(row);
      return;
    }

    var panel = makeEl(doc, 'div', 'agy-gh-panel');
    panel.setAttribute('data-agy-github-auth', 'panel');

    if (activeSession.status === 'starting') {
      panel.appendChild(makeEl(doc, 'p', 'agy-gh-status', 'Starting GitHub browser sign-in\u2026'));
      var startActions = makeEl(doc, 'div', 'agy-gh-auth-row');
      var cancelStart = makeEl(doc, 'button', 'agy-gh-btn', 'Cancel');
      cancelStart.type = 'button';
      cancelStart.setAttribute('data-agy-github-auth', 'cancel-btn');
      cancelStart.addEventListener('click', cancelActiveSession);
      startActions.appendChild(cancelStart);
      panel.appendChild(startActions);
    } else if (activeSession.status === 'awaiting') {
      panel.appendChild(makeEl(doc, 'p', 'agy-gh-title', 'Enter this one-time code on GitHub to authorize:'));
      var codeRow = makeEl(doc, 'div', 'agy-gh-code-row');
      var codeBox = makeEl(doc, 'code', 'agy-gh-code', activeSession.userCode);
      codeBox.setAttribute('data-agy-github-auth', 'user-code');
      codeRow.appendChild(codeBox);

      var copyBtn = makeEl(doc, 'button', 'agy-gh-btn', activeSession.copied ? 'Copied' : 'Copy code');
      copyBtn.type = 'button';
      copyBtn.setAttribute('data-agy-github-auth', 'copy-btn');
      copyBtn.addEventListener('click', function () {
        if (!activeSession) return;
        activeSession.copied = copyCode(activeSession.userCode) || true;
        renderAll();
      });
      codeRow.appendChild(copyBtn);
      panel.appendChild(codeRow);

      var actions = makeEl(doc, 'div', 'agy-gh-auth-row');
      var openBtn = makeEl(doc, 'button', 'agy-gh-btn agy-gh-btn-primary');
      openBtn.type = 'button';
      openBtn.setAttribute('data-agy-github-auth', 'open-btn');
      openBtn.innerHTML = GITHUB_ICON_SVG + '<span>Open GitHub</span>';
      openBtn.addEventListener('click', function () {
        if (!activeSession) return;
        if (!activeSession.copied) {
          activeSession.copied = copyCode(activeSession.userCode);
        }
        openDevicePage(activeSession.verificationUri);
        renderAll();
      });
      actions.appendChild(openBtn);

      var cancelBtn = makeEl(doc, 'button', 'agy-gh-btn', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.setAttribute('data-agy-github-auth', 'cancel-btn');
      cancelBtn.addEventListener('click', cancelActiveSession);
      actions.appendChild(cancelBtn);
      panel.appendChild(actions);

      var statusText = activeSession.copied
        ? 'Code copied to clipboard. Waiting for GitHub approval\u2026'
        : 'Waiting for GitHub approval\u2026';
      panel.appendChild(makeEl(doc, 'p', 'agy-gh-status', statusText));
    } else if (activeSession.status === 'submitting') {
      panel.appendChild(makeEl(doc, 'p', 'agy-gh-status', 'Authorized! Connecting GitHub account\u2026'));
    } else if (activeSession.status === 'error') {
      panel.appendChild(makeEl(doc, 'p', 'agy-gh-error', activeSession.error || 'GitHub sign-in failed.'));
      var errActions = makeEl(doc, 'div', 'agy-gh-auth-row');
      var retryBtn = makeEl(doc, 'button', 'agy-gh-btn agy-gh-btn-primary', 'Try again');
      retryBtn.type = 'button';
      retryBtn.setAttribute('data-agy-github-auth', 'retry-btn');
      retryBtn.addEventListener('click', function () {
        var retryAdd = activeSession ? activeSession.addAccount : hasAccounts;
        startFlow(retryAdd);
      });
      errActions.appendChild(retryBtn);

      var dismissBtn = makeEl(doc, 'button', 'agy-gh-btn', 'Cancel');
      dismissBtn.type = 'button';
      dismissBtn.setAttribute('data-agy-github-auth', 'cancel-btn');
      dismissBtn.addEventListener('click', cancelActiveSession);
      errActions.appendChild(dismissBtn);
      panel.appendChild(errActions);
    }

    container.appendChild(panel);
  }

  function renderAll() {
    if (!getBridge()) return;
    if (typeof document === 'undefined') return;
    installStyles(document);
    var card = findGitHubLocalCard();
    if (card) {
      renderIntoCard(card);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      renderAll();
    }, 60);
  }

  function onAppResume() {
    if (!activeSession || activeSession.status !== 'awaiting' || activeSession.inFlight || activeSession.canceled) {
      return;
    }
    var elapsed = Date.now() - (activeSession.lastPollAt || 0);
    var remaining = Math.max(250, activeSession.intervalMs - elapsed);
    schedulePoll(activeSession, remaining);
  }

  function init() {
    if (typeof document === 'undefined') return;
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('focus', onAppResume);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          onAppResume();
        }
      });
    }
    if (typeof MutationObserver === 'function') {
      var target = document.body || document.documentElement;
      if (target) {
        var obs = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (!isInsideOurUi(mutations[i].target)) {
              scheduleScan();
              return;
            }
          }
        });
        obs.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
      }
    }
    renderAll();
  }

  global.__agGitHubDeviceAuth = {
    scan: renderAll,
    cancel: cancelActiveSession,
    getState: function () {
      if (!activeSession) return { status: 'idle' };
      return {
        status: activeSession.status,
        userCode: activeSession.userCode,
        verificationUri: activeSession.verificationUri,
        intervalMs: activeSession.intervalMs,
        addAccount: activeSession.addAccount,
        copied: activeSession.copied,
        error: activeSession.error
      };
    }
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
}


})();
