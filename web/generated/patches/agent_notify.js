(function(){
/**
 * patches/agent_notify/install.js - Bridges upstream Antigravity agent notifications
 * (via window.nativeNotifications and Web Notification API fallback) to native Android
 * background notifications, with foreground-state focus sync and conversation deep-linking.
 */
var global = typeof window !== 'undefined' ? window : this;
if (!global.__AG_AGENT_NOTIFY_INSTALLED__) {
  global.__AG_AGENT_NOTIFY_INSTALLED__ = true;

  var lastSentByKey = {};
  var lastDoneByConv = {};
  var seenNotificationIds = {};
  var seenNotificationQueue = [];
  var MAX_SEEN_IDS = 200;
  var DEBOUNCE_MS = 2500;
  var DONE_COOLDOWN_MS = 15000;
  var clickListeners = [];
  var pendingClickedConvId = global.__AG_PENDING_NOTIFICATION_CONV_ID__ || null;

  var origHasFocus = (typeof document !== 'undefined' && typeof document.hasFocus === 'function')
    ? document.hasFocus.bind(document)
    : null;

  var hostForegroundFlag = (typeof global.__AG_HOST_IN_FOREGROUND__ === 'boolean')
    ? global.__AG_HOST_IN_FOREGROUND__
    : undefined;
  var onForegroundFlagChanged = null;
  var onUpstreamDoneSent = null;

  try {
    Object.defineProperty(global, '__AG_HOST_IN_FOREGROUND__', {
      configurable: true,
      enumerable: true,
      get: function () {
        return hostForegroundFlag;
      },
      set: function (val) {
        var next = Boolean(val);
        var changed = (hostForegroundFlag !== next);
        hostForegroundFlag = next;
        if (changed && typeof onForegroundFlagChanged === 'function') {
          try { onForegroundFlagChanged(next); } catch (ignored) {}
        }
      }
    });
  } catch (ignored) {}

  function getBridge() {
    return global.Android || global.AndroidBridge || null;
  }

  function isHostInForeground() {
    try {
      var bridge = getBridge();
      if (bridge && typeof bridge.isInForeground === 'function') {
        return Boolean(bridge.isInForeground());
      }
    } catch (ignored) {}
    if (typeof hostForegroundFlag === 'boolean') {
      return hostForegroundFlag;
    }
    if (typeof document !== 'undefined') {
      if (document.visibilityState === 'hidden') return false;
      if (origHasFocus) {
        try { return Boolean(origHasFocus()); } catch (ignored) {}
      }
    }
    return true;
  }

  // Keep document.hasFocus() accurate when MainActivity is backgrounded/screen-off.
  // WebViewLifecycle.pause() intentionally leaves the WebView unpaused so agent streams
  // keep draining in the background, which can leave Chromium's document.hasFocus() === true
  // and cause upstream isConversationInView() to suppress background notifications.
  try {
    if (typeof document !== 'undefined' && origHasFocus) {
      document.hasFocus = function () {
        if (!isHostInForeground()) {
          return false;
        }
        return origHasFocus();
      };
    }
  } catch (ignored) {}

  function rememberNotificationId(notifId) {
    if (!notifId) return false;
    var key = String(notifId);
    if (seenNotificationIds[key]) return true;
    seenNotificationIds[key] = true;
    seenNotificationQueue.push(key);
    if (seenNotificationQueue.length > MAX_SEEN_IDS) {
      var oldest = seenNotificationQueue.shift();
      if (oldest) delete seenNotificationIds[oldest];
    }
    return false;
  }

  function isUrgentEventType(typeStr) {
    return typeStr === 'approval' || typeStr === 'action_required' || typeStr === 'request_action';
  }

  function sendNativeAlert(eventType, title, body, conversationId, notificationId, silent) {
    try {
      if (isHostInForeground()) {
        return false;
      }
      var convId = conversationId ? String(conversationId).trim() : '';
      var notifId = notificationId ? String(notificationId).trim() : '';
      if (notifId && rememberNotificationId(notifId)) {
        return false;
      }

      var typeStr = String(eventType || 'done');
      var urgent = isUrgentEventType(typeStr);
      var debounceKey = typeStr + ':' + convId;
      var convKey = convId || '__active__';
      var now = Date.now();
      if (urgent) {
        if (lastSentByKey[debounceKey] && (now - lastSentByKey[debounceKey]) < DEBOUNCE_MS) {
          return false;
        }
      } else {
        if (lastDoneByConv[convKey] && (now - lastDoneByConv[convKey]) < DONE_COOLDOWN_MS) {
          return false;
        }
        if (lastSentByKey[debounceKey] && (now - lastSentByKey[debounceKey]) < DEBOUNCE_MS) {
          return false;
        }
      }
      lastSentByKey[debounceKey] = now;
      if (!urgent) {
        lastDoneByConv[convKey] = now;
      }

      var token = global.__AG_NATIVE_BRIDGE_TOKEN__;
      var bridge = getBridge();
      if (!token || !bridge) {
        return false;
      }
      var safeTitle = String(title || 'Antigravity');
      var safeBody = String(body || 'Agent update ready');
      if (typeof bridge.notifyAgentEventRich === 'function') {
        bridge.notifyAgentEventRich(
          String(token),
          typeStr,
          safeTitle,
          safeBody,
          convId,
          notifId,
          Boolean(silent)
        );
        return true;
      } else if (typeof bridge.notifyAgentEvent === 'function') {
        bridge.notifyAgentEvent(String(token), typeStr, safeTitle, safeBody);
        return true;
      }
      return false;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[AGY_NOTIFY] dispatch error', e);
      }
      return false;
    }
  }

  function dispatchNotificationClick(conversationId) {
    if (!conversationId) return;
    var cid = String(conversationId).trim();
    if (!cid) return;
    if (clickListeners.length === 0) {
      pendingClickedConvId = cid;
      global.__AG_PENDING_NOTIFICATION_CONV_ID__ = cid;
      return;
    }
    pendingClickedConvId = null;
    global.__AG_PENDING_NOTIFICATION_CONV_ID__ = null;
    for (var i = 0; i < clickListeners.length; i++) {
      try {
        clickListeners[i]({ cascadeId: cid });
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[AGY_NOTIFY] click listener error', e);
        }
      }
    }
  }

  global.__agOpenNotificationConversation = dispatchNotificationClick;

  // 1. Primary path: upstream main.js natively checks window.nativeNotifications
  //    (fJd notification service) for agent completion, replies, and approval/question prompts,
  //    and registers an onClicked({ cascadeId }) handler wired directly to the conversation router.
  try {
    global.nativeNotifications = {
      send: function (payload) {
        var p = payload || {};
        var inner = (p.payload && typeof p.payload === 'object') ? p.payload : {};
        var convId = inner.cascadeId || p.cascadeId || '';
        var notifId = p.id || '';
        var title = p.title || 'Antigravity';
        var body = p.body || 'Agent update ready';
        var eventType = (notifId && String(notifId).indexOf('agent-finished-') === 0)
          ? 'done'
          : (inner.type || 'action_required');
        sendNativeAlert(eventType, title, body, convId, notifId, Boolean(p.silent));
        if (eventType === 'done' && typeof onUpstreamDoneSent === 'function') {
          try { onUpstreamDoneSent(convId); } catch (ignored) {}
        }
        return Promise.resolve();
      },
      onClicked: function (cb) {
        if (typeof cb === 'function') {
          clickListeners.push(cb);
          var pending = pendingClickedConvId || global.__AG_PENDING_NOTIFICATION_CONV_ID__;
          if (pending) {
            pendingClickedConvId = null;
            global.__AG_PENDING_NOTIFICATION_CONV_ID__ = null;
            try {
              cb({ cascadeId: String(pending) });
            } catch (ignored) {}
          }
        }
        return function () {
          var idx = clickListeners.indexOf(cb);
          if (idx >= 0) {
            clickListeners.splice(idx, 1);
          }
        };
      },
      openSystemPreferences: function () {
        try {
          var token = global.__AG_NATIVE_BRIDGE_TOKEN__;
          var bridge = getBridge();
          if (token && bridge && typeof bridge.openNotificationSettings === 'function') {
            bridge.openNotificationSettings(String(token));
          }
        } catch (ignored) {}
        return Promise.resolve();
      }
    };
  } catch (ignored) {}

  // 2. Fallback: shim window.Notification so any Web Notification API caller
  //    also surfaces natively in Android's status bar.
  try {
    var NativeNotification = global.Notification;
    var WrappedNotification = function (title, options) {
      var opts = options || {};
      var data = (opts.data && typeof opts.data === 'object') ? opts.data : {};
      var convId = data.cascadeId || '';
      var notifId = opts.tag || '';
      sendNativeAlert('web_notification', title || 'Antigravity',
        opts.body || 'Tap to open Antigravity', convId, notifId, Boolean(opts.silent));
      this.title = title || '';
      this.body = opts.body || '';
      this.tag = notifId;
      this.close = function () {};
      this.addEventListener = function () {};
      this.removeEventListener = function () {};
      if (typeof NativeNotification === 'function') {
        try {
          return new NativeNotification(title, options);
        } catch (ignored) {}
      }
    };
    WrappedNotification.permission = 'granted';
    WrappedNotification.requestPermission = function (cb) {
      if (typeof cb === 'function') {
        try { cb('granted'); } catch (ignored) {}
      }
      return Promise.resolve('granted');
    };
    global.Notification = WrappedNotification;
  } catch (ignored) {}

  // 3. Background Assistant Reply Watcher:
  //    In Swarm conversations, background monitors keep the conversation active
  //    ("Waiting for subagent") instead of transitioning to IDLE, so upstream
  //    window.nativeNotifications.send never fires when the coordinator posts a reply.
  //    While backgrounded, watch [data-testid="conversation-view"] for a new, settled
  //    assistant reply ONLY after the agent stops actively working/generating, and
  //    dispatch via sendNativeAlert('done', ...) with shared dedupe & 15s cooldown.
  try {
    var REPLY_SETTLE_MS = 2500;
    var MUTATION_THROTTLE_MS = 250;
    var BG_POLL_MS = 1500;
    var MAX_SNIPPET_LEN = 180;
    var EXCLUDED_TEXT_SELECTOR = [
      '.sr-only',
      '[data-find-ignore]',
      '[aria-hidden="true"]',
      '[data-side-panel-focus-scope="true"]',
      '[data-testid="live-status-row"]',
      '[data-testid="live-status-hover"]',
      '[data-testid="idle-status-text"]',
      '[data-testid="turn-cards-container"]',
      '[data-testid="subagent-node"]',
      '[data-testid="coordinator-worker-card"]',
      '[data-testid="coordinator-hover-card"]',
      '[data-testid="running-items-card"]',
      '[data-testid="inline-card"]',
      '[data-testid="inline-card-in-chat"]',
      '[data-testid="inline-permission-card"]',
      '[data-testid="agent-inline-card-slot"]',
      '[data-testid="mcp-tool-step"]',
      '[data-testid="ephemeral-tool-status"]',
      '[data-testid="tool-group-elapsed"]',
      '[data-testid="tool-permissions-row"]',
      '[data-testid="artifact-card"]',
      '[data-testid="bubble-artifact-card"]',
      '[data-testid="bubble-artifact-cards"]',
      '[data-testid="changed-files-card"]',
      '[data-testid="step-plan"]',
      '[data-testid="browser-subagent-thinking"]',
      '[data-testid="browser-subagent-steps"]',
      '[data-testid="side-question-followup-thinking"]',
      '[data-testid="side-question-tool-status"]',
      '[data-testid="agent-loading"]',
      '[data-testid="status-loading-spinner"]',
      'button',
      'svg',
      'style',
      'script'
    ].join(',');
    var IGNORED_STATUS_TEXT = {
      'agent working': true,
      'agent said': true,
      'waiting for subagent': true,
      'working': true,
      'thinking': true,
      'running': true,
      'generating': true
    };
    var ACTIVE_WORK_RE = /\b(working|thinking|running|generating|streaming|planning|searching|reading|editing|executing|analyzing)\b/i;
    var WAITING_SUBAGENT_RE = /\bwaiting\s+for\b/i;

    var bgWatcherActive = false;
    var bgConvId = '';
    var baselineFingerprint = '';
    var baselineText = '';
    var lastNotifiedTextByConv = {};
    var pendingFingerprint = '';
    var pendingText = '';
    var settleTimer = null;
    var throttleTimer = null;
    var bgPollTimer = null;
    var replyObserver = null;
    var observedTarget = null;

    function normalizeText(str) {
      return String(str || '').replace(/\s+/g, ' ').trim();
    }

    function simpleHash(str) {
      var h = 2166136261;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
      }
      return h.toString(36);
    }

    function isInsideSidePanel(node) {
      if (!node) return false;
      try {
        if (typeof node.closest === 'function') {
          return Boolean(node.closest('[data-side-panel-focus-scope="true"]'));
        }
        var cur = node.parentNode || node.parentElement;
        while (cur) {
          if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-side-panel-focus-scope') === 'true') {
            return true;
          }
          cur = cur.parentNode || cur.parentElement;
        }
      } catch (ignored) {}
      return false;
    }

    function isDisabledControl(el) {
      if (!el) return true;
      if (el.disabled) return true;
      try {
        if (typeof el.getAttribute === 'function') {
          if (el.getAttribute('disabled') !== null) return true;
          if (el.getAttribute('aria-disabled') === 'true') return true;
        }
      } catch (ignored) {}
      return false;
    }

    function isStopOrCancelButton(btn) {
      if (!btn || isDisabledControl(btn) || isInsideSidePanel(btn)) {
        return false;
      }
      try {
        var testId = (typeof btn.getAttribute === 'function' && btn.getAttribute('data-testid')) || '';
        if (testId === 'input-cancel-button') return true;
        if (/^(input-)?(stop|cancel)(-generation|-button)?$/i.test(testId)) return true;
        var aria = (typeof btn.getAttribute === 'function' && btn.getAttribute('aria-label')) || '';
        if (/^(stop|cancel)\b/i.test(normalizeText(aria))) return true;
        var title = (typeof btn.getAttribute === 'function' && btn.getAttribute('title')) || '';
        if (/^(stop|cancel)\b/i.test(normalizeText(title))) return true;
      } catch (ignored) {}
      return false;
    }

    function isAgentActivelyWorking(container) {
      try {
        // 1. Check composer / document for an active Stop / Cancel generation button.
        var root = (typeof document !== 'undefined') ? document : container;
        if (root && typeof root.querySelectorAll === 'function') {
          var cancelBtns = root.querySelectorAll('[data-testid="input-cancel-button"]');
          for (var c = 0; c < cancelBtns.length; c++) {
            if (isStopOrCancelButton(cancelBtns[c])) return true;
          }
          var composers = root.querySelectorAll('[data-agent-composer-root]');
          for (var r = 0; r < composers.length; r++) {
            var comp = composers[r];
            if (!comp || isInsideSidePanel(comp) || typeof comp.querySelectorAll !== 'function') continue;
            var compBtns = comp.querySelectorAll('button');
            for (var b = 0; b < compBtns.length; b++) {
              if (isStopOrCancelButton(compBtns[b])) return true;
            }
          }
        }

        var scope = container || getConversationView();
        if (!scope || typeof scope.querySelectorAll !== 'function') {
          return false;
        }

        // 2. Check latest agent-response heading ("Agent working" vs "Agent said").
        var responses = scope.querySelectorAll('[data-testid="agent-response"]');
        var latestResp = null;
        for (var ri = responses.length - 1; ri >= 0; ri--) {
          if (responses[ri] && !isInsideSidePanel(responses[ri])) {
            latestResp = responses[ri];
            break;
          }
        }
        if (latestResp && typeof latestResp.querySelectorAll === 'function') {
          var headings = latestResp.querySelectorAll('h6');
          for (var hi = 0; hi < headings.length; hi++) {
            if (normalizeText(headings[hi].textContent).toLowerCase() === 'agent working') {
              return true;
            }
          }
          // Explicit loading / streaming indicators inside latest agent-response.
          var loaders = latestResp.querySelectorAll('[data-testid="agent-loading"], [data-testid="status-loading-spinner"], [data-streaming="true"]');
          for (var li = 0; li < loaders.length; li++) {
            if (loaders[li] && !isInsideSidePanel(loaders[li])) {
              return true;
            }
          }
        }

        // 3. Check live-status-row: active working/thinking/running blocks notification,
        //    while "Waiting for subagent" (with no Stop button) is explicitly allowed!
        var statusRows = scope.querySelectorAll('[data-testid="live-status-row"]');
        for (var si = 0; si < statusRows.length; si++) {
          var row = statusRows[si];
          if (!row || isInsideSidePanel(row)) continue;
          var statusText = normalizeText(row.textContent).toLowerCase();
          if (statusText && WAITING_SUBAGENT_RE.test(statusText)) {
            continue;
          }
          if (typeof row.querySelector === 'function' && row.querySelector('[data-testid="live-status-hover"]')) {
            return true;
          }
          if (statusText && ACTIVE_WORK_RE.test(statusText)) {
            return true;
          }
        }
      } catch (ignored) {}
      return false;
    }

    function getConversationView() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
        return null;
      }
      return document.querySelector('[data-testid="conversation-view"]');
    }

    function getActiveConversationId(viewEl) {
      try {
        var el = viewEl || getConversationView();
        if (el && typeof el.getAttribute === 'function') {
          var attr = el.getAttribute('data-cascade-id');
          if (attr && attr !== 'conversation') {
            return String(attr).trim();
          }
        }
      } catch (ignored) {}
      try {
        var loc = global.location;
        if (loc && typeof loc.pathname === 'string') {
          var m = loc.pathname.match(/\/(?:c|conversations)\/([^/?#]+)/);
          if (m && m[1]) {
            return decodeURIComponent(m[1]).trim();
          }
        }
        if (loc && typeof loc.search === 'string') {
          var sm = loc.search.match(/[?&](?:cascadeId|conversationId)=([^&#]+)/);
          if (sm && sm[1]) {
            return decodeURIComponent(sm[1]).trim();
          }
        }
      } catch (ignored) {}
      return '';
    }

    function extractCleanText(node) {
      if (!node) return '';
      try {
        if (typeof node.cloneNode === 'function') {
          var clone = node.cloneNode(true);
          if (typeof clone.querySelectorAll === 'function') {
            var excluded = clone.querySelectorAll(EXCLUDED_TEXT_SELECTOR);
            for (var i = 0; i < excluded.length; i++) {
              if (excluded[i] && excluded[i].parentNode) {
                excluded[i].parentNode.removeChild(excluded[i]);
              }
            }
          }
          return normalizeText(clone.textContent);
        }
      } catch (ignored) {}
      return normalizeText(node.innerText || node.textContent || '');
    }

    function isIgnoredStatusOnly(text) {
      if (!text) return true;
      var lower = text.toLowerCase();
      if (IGNORED_STATUS_TEXT[lower]) return true;
      if (WAITING_SUBAGENT_RE.test(lower) && lower.length < 48) return true;
      return false;
    }

    function makeTextFingerprint(kind, text) {
      return kind + ':' + text.length + ':' + simpleHash(text);
    }

    function readLatestAssistantReply(viewEl) {
      var empty = { fingerprint: '', text: '' };
      if (!viewEl || typeof viewEl.querySelectorAll !== 'function') {
        return empty;
      }

      // Path A: Coordinator / bubble layout ([data-testid="agent-response"] [data-bubble-side="agent"])
      var bubbles = viewEl.querySelectorAll('[data-testid="agent-response"] [data-bubble-side="agent"]');
      if (bubbles && bubbles.length > 0) {
        for (var i = bubbles.length - 1; i >= 0; i--) {
          var b = bubbles[i];
          if (!b || isInsideSidePanel(b)) continue;
          var bText = extractCleanText(b);
          if (!isIgnoredStatusOnly(bText)) {
            return {
              fingerprint: makeTextFingerprint('bubble', bText),
              text: bText
            };
          }
        }
        return empty;
      }

      // Path B: Standard step-list layout ([data-testid="agent-response"])
      var responses = viewEl.querySelectorAll('[data-testid="agent-response"]');
      if (!responses || responses.length === 0) {
        return empty;
      }
      var lastResp = null;
      for (var ri = responses.length - 1; ri >= 0; ri--) {
        if (responses[ri] && !isInsideSidePanel(responses[ri])) {
          lastResp = responses[ri];
          break;
        }
      }
      if (!lastResp) {
        return empty;
      }

      if (typeof lastResp.querySelectorAll === 'function') {
        var mdBlocks = lastResp.querySelectorAll('[data-markdown-block-index]');
        if (mdBlocks && mdBlocks.length > 0) {
          var lastBlock = mdBlocks[mdBlocks.length - 1];
          var mdParent = lastBlock && lastBlock.parentNode;
          var parts = [];
          if (mdParent && typeof mdParent.querySelectorAll === 'function') {
            var groupBlocks = mdParent.querySelectorAll('[data-markdown-block-index]');
            for (var j = 0; j < groupBlocks.length; j++) {
              var gText = extractCleanText(groupBlocks[j]);
              if (gText) parts.push(gText);
            }
          } else {
            var singleText = extractCleanText(lastBlock);
            if (singleText) parts.push(singleText);
          }
          var joined = normalizeText(parts.join(' '));
          if (!isIgnoredStatusOnly(joined)) {
            return {
              fingerprint: makeTextFingerprint('md', joined),
              text: joined
            };
          }
        }
      }

      // Fallback: cleaned text of the latest agent-response container
      var fallbackText = extractCleanText(lastResp);
      if (!isIgnoredStatusOnly(fallbackText)) {
        return {
          fingerprint: makeTextFingerprint('resp', fallbackText),
          text: fallbackText
        };
      }
      return empty;
    }

    function clearPendingReply() {
      pendingFingerprint = '';
      pendingText = '';
      if (settleTimer !== null && typeof clearTimeout === 'function') {
        clearTimeout(settleTimer);
      }
      settleTimer = null;
    }

    function detachObserver() {
      if (replyObserver) {
        try { replyObserver.disconnect(); } catch (ignored) {}
        replyObserver = null;
      }
      observedTarget = null;
    }

    function attachObserver(target) {
      if (typeof MutationObserver !== 'function') return;
      var node = target || (typeof document !== 'undefined' ? (document.body || document.documentElement) : null);
      if (!node || node === observedTarget) return;
      detachObserver();
      try {
        replyObserver = new MutationObserver(scheduleReplyCheck);
        replyObserver.observe(node, { childList: true, subtree: true, characterData: true });
        observedTarget = node;
      } catch (ignored) {
        replyObserver = null;
        observedTarget = null;
      }
    }

    function stopBackgroundWatcher() {
      bgWatcherActive = false;
      bgConvId = '';
      baselineFingerprint = '';
      baselineText = '';
      clearPendingReply();
      detachObserver();
      if (throttleTimer !== null && typeof clearTimeout === 'function') {
        clearTimeout(throttleTimer);
      }
      throttleTimer = null;
      if (bgPollTimer !== null && typeof clearInterval === 'function') {
        clearInterval(bgPollTimer);
      }
      bgPollTimer = null;
    }

    function onReplySettled() {
      settleTimer = null;
      if (!bgWatcherActive || isHostInForeground()) {
        stopBackgroundWatcher();
        return;
      }
      var viewEl = getConversationView();
      if (isAgentActivelyWorking(viewEl)) {
        clearPendingReply();
        return;
      }
      var convId = getActiveConversationId(viewEl);
      var convKey = convId || '__active__';
      if (convId !== bgConvId) {
        bgConvId = convId;
        var switchedSnap = readLatestAssistantReply(viewEl);
        baselineFingerprint = switchedSnap.fingerprint;
        baselineText = switchedSnap.text;
        clearPendingReply();
        return;
      }
      var snap = readLatestAssistantReply(viewEl);
      if (!snap.text || snap.fingerprint === baselineFingerprint || snap.text === baselineText) {
        clearPendingReply();
        return;
      }
      if (lastNotifiedTextByConv[convKey] && snap.text === lastNotifiedTextByConv[convKey]) {
        baselineFingerprint = snap.fingerprint;
        baselineText = snap.text;
        clearPendingReply();
        return;
      }
      if (snap.fingerprint !== pendingFingerprint) {
        pendingFingerprint = snap.fingerprint;
        pendingText = snap.text;
        if (typeof setTimeout === 'function') {
          settleTimer = setTimeout(onReplySettled, REPLY_SETTLE_MS);
        }
        return;
      }

      // Reply has settled and agent is no longer actively working:
      // update baseline & lastNotifiedText first so this reply can never fire twice.
      baselineFingerprint = snap.fingerprint;
      baselineText = snap.text;
      var fullText = snap.text;
      clearPendingReply();

      var snippet = fullText.length > MAX_SNIPPET_LEN
        ? (fullText.slice(0, MAX_SNIPPET_LEN - 3).trim() + '...')
        : fullText;
      var dedupeKey = 'bg-reply-' + (convId || 'active') + '-' + simpleHash(fullText);
      var sent = sendNativeAlert('done', 'Antigravity', snippet, convId, dedupeKey, false);
      if (sent) {
        lastNotifiedTextByConv[convKey] = fullText;
      }
    }

    function checkForBackgroundReply() {
      if (!bgWatcherActive) return;
      if (isHostInForeground()) {
        stopBackgroundWatcher();
        return;
      }
      var viewEl = getConversationView();
      if (viewEl && viewEl !== observedTarget) {
        attachObserver(viewEl);
      }
      var convId = getActiveConversationId(viewEl);
      var convKey = convId || '__active__';
      if (convId !== bgConvId) {
        bgConvId = convId;
        var switchedSnap = readLatestAssistantReply(viewEl);
        baselineFingerprint = switchedSnap.fingerprint;
        baselineText = switchedSnap.text;
        clearPendingReply();
        return;
      }
      // Never settle or notify while agent is actively generating/working.
      if (isAgentActivelyWorking(viewEl)) {
        if (pendingFingerprint || settleTimer !== null) {
          clearPendingReply();
        }
        return;
      }
      var snap = readLatestAssistantReply(viewEl);
      if (!snap.text || snap.fingerprint === baselineFingerprint || snap.text === baselineText) {
        if (pendingFingerprint) {
          clearPendingReply();
        }
        return;
      }
      if (lastNotifiedTextByConv[convKey] && snap.text === lastNotifiedTextByConv[convKey]) {
        baselineFingerprint = snap.fingerprint;
        baselineText = snap.text;
        clearPendingReply();
        return;
      }
      if (snap.fingerprint !== pendingFingerprint) {
        pendingFingerprint = snap.fingerprint;
        pendingText = snap.text;
        if (settleTimer !== null && typeof clearTimeout === 'function') {
          clearTimeout(settleTimer);
        }
        if (typeof setTimeout === 'function') {
          settleTimer = setTimeout(onReplySettled, REPLY_SETTLE_MS);
        }
      }
    }

    function scheduleReplyCheck() {
      if (!bgWatcherActive || throttleTimer !== null) return;
      if (typeof setTimeout !== 'function') {
        checkForBackgroundReply();
        return;
      }
      throttleTimer = setTimeout(function () {
        throttleTimer = null;
        checkForBackgroundReply();
      }, MUTATION_THROTTLE_MS);
    }

    function startBackgroundWatcher() {
      if (bgWatcherActive) return;
      var viewEl = getConversationView();
      bgWatcherActive = true;
      bgConvId = getActiveConversationId(viewEl);
      var initSnap = readLatestAssistantReply(viewEl);
      baselineFingerprint = initSnap.fingerprint;
      baselineText = initSnap.text;
      clearPendingReply();
      attachObserver(viewEl);
      if (bgPollTimer === null && typeof setInterval === 'function') {
        bgPollTimer = setInterval(checkForBackgroundReply, BG_POLL_MS);
      }
    }

    function syncForegroundWatcher() {
      if (isHostInForeground()) {
        if (bgWatcherActive) {
          var fgConvKey = bgConvId || '__active__';
          delete lastNotifiedTextByConv[fgConvKey];
          stopBackgroundWatcher();
        }
      } else {
        if (!bgWatcherActive) {
          startBackgroundWatcher();
        }
      }
    }

    onForegroundFlagChanged = function (inFg) {
      if (inFg) {
        var fgConvKey = bgConvId || '__active__';
        delete lastNotifiedTextByConv[fgConvKey];
        stopBackgroundWatcher();
      } else {
        startBackgroundWatcher();
      }
    };

    onUpstreamDoneSent = function (convId) {
      if (!bgWatcherActive) return;
      var viewEl = getConversationView();
      var activeConvId = getActiveConversationId(viewEl);
      if (!convId || !activeConvId || String(convId) === activeConvId) {
        var snap = readLatestAssistantReply(viewEl);
        baselineFingerprint = snap.fingerprint;
        baselineText = snap.text;
        if (snap.text) {
          lastNotifiedTextByConv[activeConvId || '__active__'] = snap.text;
        }
        clearPendingReply();
      }
    };

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', syncForegroundWatcher, true);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pagehide', syncForegroundWatcher);
      global.addEventListener('pageshow', syncForegroundWatcher);
      global.addEventListener('blur', syncForegroundWatcher);
      global.addEventListener('focus', syncForegroundWatcher);
    }

    // If loaded while already backgrounded, arm immediately.
    if (!isHostInForeground()) {
      startBackgroundWatcher();
    }
  } catch (ignored) {}
}


})();
