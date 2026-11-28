/**
 * patches/back_navigation/install.js - Step-by-step Android Back handling:
 *   1. Step back inside or dismiss the topmost open overlay (Settings sheets,
 *      Customizations / app-wide modals, Side Panel, dropdown/action sheets).
 *   2. Handle in-layout Back / Close Sidebar controls (Onboarding, overlay sidebar).
 *   3. Step back 1 route via renderer-initiated window.history.back() when
 *      TanStack Router __TSR_index > 0 (avoiding Chromium WebView's native
 *      webView.goBack() skipping pushState entries on loadDataWithBaseURL),
 *      with parent breadcrumb / mobile-back-to-home fallback when __TSR_index === 0.
 *   4. Return 'exit' on clean Home ('/') so native BackNavigator exits cleanly
 *      instead of bouncing back into prior routes via webView.goBack().
 */
var global = typeof window !== 'undefined' ? window : this;
if (!global.__AG_BACK_NAVIGATION_INSTALLED__) {
  global.__AG_BACK_NAVIGATION_INSTALLED__ = true;

  var OVERLAY_SELECTOR =
    '[data-bottom-sheet-popup]:not([data-closed]), ' +
    '.settings-modal-container:not([aria-hidden="true"]), ' +
    '[role="dialog"]:not([data-closed]), ' +
    '[role="alertdialog"]:not([data-closed]), ' +
    '[role="menu"][data-open], ' +
    '[role="listbox"][data-open]';

  var BACK_BUTTON_SELECTOR = 'button[aria-label="Back"]:not([disabled])';
  var SIDEBAR_CLOSE_BUTTON_SELECTOR = 'button[aria-label="Close Sidebar"]:not([disabled])';
  var DIALOG_CLOSE_BUTTON_SELECTOR =
    'button[aria-label="Close"]:not([disabled]), ' +
    'button[aria-label="Close Logs Modal"]:not([disabled])';
  var IN_LAYOUT_BACK_SELECTOR =
    SIDEBAR_CLOSE_BUTTON_SELECTOR + ', ' +
    'button[data-testid="onboarding-back"][aria-label="Back"]:not([disabled])';
  var BREADCRUMB_NAV_SELECTOR = 'nav[aria-label="Breadcrumb"]';
  var BREADCRUMB_SEGMENT_SELECTOR = '[data-testid="breadcrumb-segment"]';
  var MOBILE_HOME_BACK_SELECTOR = 'button[data-testid="mobile-back-to-home"]:not([disabled])';
  var SETTINGS_NAV_MARKER_SELECTOR =
    '[data-testid^="settings-nav-item-"], [data-testid="settings-disabled-notice"]';

  function getStyle(el) {
    if (typeof global.getComputedStyle === 'function') {
      try {
        return global.getComputedStyle(el);
      } catch (ignored) {}
    }
    return el && el.style ? el.style : null;
  }

  function isVisible(el) {
    if (!el) return false;
    var style = getStyle(el);
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }
    if (typeof el.getBoundingClientRect !== 'function') {
      return false;
    }
    var rect = el.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function isHiddenOrInert(el) {
    if (!el) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute && (el.hasAttribute('inert') || el.hasAttribute('data-closed'))) {
      return true;
    }
    if (typeof el.closest === 'function') {
      if (
        el.closest('[inert]') ||
        el.closest('[aria-hidden="true"]') ||
        el.closest('[data-closed]')
      ) {
        return true;
      }
    }
    var cur = el.parentElement || el.parent || null;
    while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      var st = getStyle(cur);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) {
        return true;
      }
      cur = cur.parentElement || cur.parent || null;
    }
    return false;
  }

  function isInteractable(el) {
    if (!el || el.disabled) return false;
    if (el.hasAttribute && el.hasAttribute('disabled')) return false;
    if (isHiddenOrInert(el)) return false;
    return isVisible(el);
  }

  function getEffectiveZIndex(el) {
    var best = null;
    var cur = el;
    while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      var style = getStyle(cur);
      if (style && style.zIndex != null && style.zIndex !== '' && style.zIndex !== 'auto') {
        var n = parseInt(style.zIndex, 10);
        if (!isNaN(n) && (best === null || n > best)) {
          best = n;
        }
      }
      cur = cur.parentElement || cur.parent || null;
    }
    return best === null ? 0 : best;
  }

  function getSearchParam(name) {
    if (!global.location || typeof global.location.search !== 'string') {
      return null;
    }
    var search = global.location.search;
    if (!search || search === '?') return null;
    if (typeof global.URLSearchParams === 'function') {
      try {
        return new global.URLSearchParams(search).get(name);
      } catch (ignored) {}
    }
    var raw = search.charAt(0) === '?' ? search.slice(1) : search;
    var pairs = raw.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('=');
      var key = eq >= 0 ? pairs[i].slice(0, eq) : pairs[i];
      if (decodeURIComponent(key) === name) {
        return eq >= 0 ? decodeURIComponent(pairs[i].slice(eq + 1)) : '';
      }
    }
    return null;
  }

  function hasSearchParam(name, expectedValue) {
    var val = getSearchParam(name);
    if (val === null) return false;
    return expectedValue === undefined ? true : val === expectedValue;
  }

  function hasClass(el, className) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') {
      return el.classList.contains(className);
    }
    if (typeof el.className === 'string') {
      return (' ' + el.className + ' ').indexOf(' ' + className + ' ') !== -1;
    }
    return false;
  }

  function hasQueryMatch(root, selector) {
    if (!root) return false;
    if (typeof root.querySelector === 'function') {
      return Boolean(root.querySelector(selector));
    }
    if (typeof root.querySelectorAll === 'function') {
      var list = root.querySelectorAll(selector);
      return Boolean(list && list.length > 0);
    }
    return false;
  }

  function isBottomSheet(overlay) {
    return Boolean(
      overlay && overlay.hasAttribute && overlay.hasAttribute('data-bottom-sheet-popup')
    );
  }

  function isUrlBackedOverlay(overlay) {
    if (!overlay) return false;
    if (hasClass(overlay, 'settings-modal-container')) {
      return true;
    }
    if (
      isBottomSheet(overlay) &&
      overlay.getAttribute &&
      overlay.getAttribute('data-sheet-depth') === '0' &&
      hasSearchParam('settingsOpen', 'true') &&
      hasQueryMatch(overlay, SETTINGS_NAV_MARKER_SELECTOR)
    ) {
      return true;
    }
    if (
      !isBottomSheet(overlay) &&
      overlay.getAttribute &&
      overlay.getAttribute('role') === 'dialog' &&
      (hasSearchParam('feedbackOpen', 'true') ||
        (hasSearchParam('settingsOpen', 'true') &&
          hasQueryMatch(overlay, '[data-testid="settings-disabled-notice"]')))
    ) {
      return true;
    }
    return false;
  }

  function isDialogOverlay(overlay) {
    if (!overlay || !overlay.getAttribute || isBottomSheet(overlay)) return false;
    var role = overlay.getAttribute('role');
    return role === 'dialog' || role === 'alertdialog';
  }

  function findFirstInteractable(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return null;
    }
    var list = root.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      if (isInteractable(list[i])) {
        return list[i];
      }
    }
    return null;
  }

  function findLastInteractable(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return null;
    }
    var list = root.querySelectorAll(selector);
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (isInteractable(list[i])) {
        target = list[i];
      }
    }
    return target;
  }

  function findTopmostOverlay() {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return null;
    }
    var candidates = document.querySelectorAll(OVERLAY_SELECTOR);
    var best = null;
    var bestZ = -Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      if (isHiddenOrInert(el)) continue;
      var z = getEffectiveZIndex(el);
      if (z >= bestZ) {
        bestZ = z;
        best = el;
      }
    }
    return best;
  }

  function dispatchEscape(target) {
    var ev;
    var init = {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    };
    if (typeof global.KeyboardEvent === 'function') {
      try {
        ev = new global.KeyboardEvent('keydown', init);
      } catch (ignored) {}
    }
    if (!ev) {
      ev = {
        type: 'keydown',
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault: function () {
          this.defaultPrevented = true;
        },
        stopPropagation: function () {}
      };
    }
    if (target && typeof target.dispatchEvent === 'function') {
      target.dispatchEvent(ev);
      return true;
    }
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(ev);
      return true;
    }
    return false;
  }

  function getRouterHistoryIndex() {
    if (!global.history || !global.history.state) {
      return null;
    }
    var idx = global.history.state.__TSR_index;
    return typeof idx === 'number' && !isNaN(idx) ? idx : null;
  }

  function canStepBackInRouterHistory() {
    if (!global.history || typeof global.history.back !== 'function') {
      return false;
    }
    var idx = getRouterHistoryIndex();
    return idx !== null && idx > 0;
  }

  function isCleanHome() {
    if (!global.location || typeof global.location.pathname !== 'string') {
      return false;
    }
    var path = global.location.pathname;
    if (path !== '/' && path !== '' && path !== '/index.html') {
      return false;
    }
    if (hasSearchParam('settingsOpen', 'true')) return false;
    if (hasSearchParam('feedbackOpen', 'true')) return false;
    if (hasSearchParam('cascadeId')) return false;
    return true;
  }

  function getPathSegments() {
    if (!global.location || typeof global.location.pathname !== 'string') {
      return [];
    }
    var path = global.location.pathname;
    if (path === '/' || path === '' || path === '/index.html') {
      return [];
    }
    var raw = path.split('/');
    var segs = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) segs.push(raw[i]);
    }
    return segs;
  }

  function isTopLevelConversationOrView(segs) {
    if (segs.length !== 2) return false;
    var head = segs[0];
    return head === 'c' || head === 'conversations' || head === 'battle' || head === 'view';
  }

  function isNestedPath() {
    var segs = getPathSegments();
    if (segs.length <= 1) return false;
    if (isTopLevelConversationOrView(segs)) return false;
    return true;
  }

  function isClickableBreadcrumbSegment(el) {
    if (!isInteractable(el)) return false;
    if (el.getAttribute && el.getAttribute('aria-current') === 'page') return false;
    var tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tag === 'A' || tag === 'BUTTON') return true;
    if (el.getAttribute && el.getAttribute('role') === 'button') return true;
    if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
    if (el.getAttribute) {
      var ti = el.getAttribute('tabindex');
      if (ti !== null && ti !== '' && parseInt(ti, 10) >= 0) return true;
    }
    return false;
  }

  function findClickableParentBreadcrumb() {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return null;
    }
    var navs = document.querySelectorAll(BREADCRUMB_NAV_SELECTOR);
    for (var n = navs.length - 1; n >= 0; n--) {
      var nav = navs[n];
      if (!isVisible(nav) || isHiddenOrInert(nav)) continue;
      if (typeof nav.querySelectorAll !== 'function') continue;
      var segments = nav.querySelectorAll(BREADCRUMB_SEGMENT_SELECTOR);
      if (!segments || segments.length < 2) continue;
      // Only consider strictly parent segments (never the leaf segment).
      for (var i = segments.length - 2; i >= 0; i--) {
        if (isClickableBreadcrumbSegment(segments[i]) && typeof segments[i].click === 'function') {
          return segments[i];
        }
      }
    }
    return null;
  }

  function hasClickableParentBreadcrumb() {
    return findClickableParentBreadcrumb() !== null;
  }

  function clickParentBreadcrumb() {
    var seg = findClickableParentBreadcrumb();
    if (seg) {
      seg.click();
      return true;
    }
    return false;
  }

  var LONG_PRESS_MS = 450;
  var mobileBackPressStartTs = 0;
  var mobileBackPressTarget = null;
  var bypassMobileHomeIntercept = false;

  function findMobileHomeBackTarget(target) {
    if (!target) return null;
    if (typeof target.closest === 'function') {
      return target.closest('[data-testid="mobile-back-to-home"]');
    }
    if (target.getAttribute && target.getAttribute('data-testid') === 'mobile-back-to-home') {
      return target;
    }
    return null;
  }

  function onMobileBackPressStart(e) {
    if (!e || !e.target) return;
    var btn = findMobileHomeBackTarget(e.target);
    if (!btn) return;
    var now = Date.now();
    if (mobileBackPressTarget === btn && mobileBackPressStartTs > 0 && (now - mobileBackPressStartTs) < 50) {
      return;
    }
    mobileBackPressTarget = btn;
    mobileBackPressStartTs = now;
  }

  function onMobileBackPressCancel() {
    mobileBackPressTarget = null;
    mobileBackPressStartTs = 0;
  }

  function onMobileBackClickCapture(e) {
    if (!e || !e.target) return;
    var btn = findMobileHomeBackTarget(e.target);
    if (!btn) return;

    var startTs = mobileBackPressTarget === btn ? mobileBackPressStartTs : 0;
    mobileBackPressTarget = null;
    mobileBackPressStartTs = 0;

    if (bypassMobileHomeIntercept) {
      return;
    }

    // Long-press (>= 450ms) jumps straight to Home via native HR() handler.
    if (startTs > 0 && (Date.now() - startTs) >= LONG_PRESS_MS) {
      return;
    }

    // Only intercept on nested sub-routes (depth > 1 or clickable parent breadcrumb).
    // At top-level routes (/customizations, /c/<id>, /conversations/<id>, etc.),
    // let native HR() jump straight to Home '/'.
    var nested = isNestedPath() || hasClickableParentBreadcrumb();
    if (!nested) {
      return;
    }

    var handled = false;
    if (canStepBackInRouterHistory()) {
      global.history.back();
      handled = true;
    } else if (clickParentBreadcrumb()) {
      handled = true;
    }

    if (handled) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      } else if (typeof e.stopPropagation === 'function') {
        e.stopPropagation();
      }
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', onMobileBackPressStart, true);
    document.addEventListener('touchstart', onMobileBackPressStart, true);
    document.addEventListener('mousedown', onMobileBackPressStart, true);
    document.addEventListener('pointercancel', onMobileBackPressCancel, true);
    document.addEventListener('touchcancel', onMobileBackPressCancel, true);
    document.addEventListener('click', onMobileBackClickCapture, true);
  }

  function handleBack() {
    try {
      // Priority 1: Topmost open overlay (bottom sheet, settings modal, dialog, menu/listbox).
      var overlay = findTopmostOverlay();
      if (overlay) {
        var backBtn = findLastInteractable(overlay, BACK_BUTTON_SELECTOR);
        if (backBtn && typeof backBtn.click === 'function') {
          backBtn.click();
          return true;
        }
        if (isUrlBackedOverlay(overlay)) {
          // Let router history pop ?settingsOpen=true / ?feedbackOpen=true cleanly
          // without leaving a duplicate history entry via replace:true Close handlers.
          if (canStepBackInRouterHistory()) {
            global.history.back();
            return true;
          }
          return false;
        }
        // For non-bottom-sheet [role="dialog"] / [role="alertdialog"]:
        // check Close Sidebar first (mobile overlay sidebar renders as role="dialog"
        // with no Escape listener), then prefer the modal's Close button (handles
        // dialogs with dismissOnOutsideInteraction=false like J5/ybd/XX/A5).
        // For bottom sheets (which also carry role="dialog" from Base UI Lvb, e.g.
        // Mobile Side Panel Sod) and menus, dispatch Escape directly so inner tab
        // Close buttons are never clicked by mistake.
        if (isDialogOverlay(overlay)) {
          var sidebarCloseBtn = findFirstInteractable(overlay, SIDEBAR_CLOSE_BUTTON_SELECTOR);
          if (sidebarCloseBtn && typeof sidebarCloseBtn.click === 'function') {
            sidebarCloseBtn.click();
            return true;
          }
          var closeBtn = findFirstInteractable(overlay, DIALOG_CLOSE_BUTTON_SELECTOR);
          if (closeBtn && typeof closeBtn.click === 'function') {
            closeBtn.click();
            return true;
          }
        }
        if (dispatchEscape(overlay)) {
          return true;
        }
        return false;
      }

      // Priority 2: In-layout dismiss/back controls (overlay sidebar, onboarding wizard).
      if (typeof document !== 'undefined') {
        var inLayoutBtn = findLastInteractable(document, IN_LAYOUT_BACK_SELECTOR);
        if (inLayoutBtn && typeof inLayoutBtn.click === 'function') {
          inLayoutBtn.click();
          return true;
        }
      }

      // Clean Home ('/') with no open overlay/settings/feedback: signal native exit
      // so webView.goBack() doesn't bounce back into prior routes after mobile-back-to-home.
      if (isCleanHome()) {
        return 'exit';
      }

      // Priority 3a: Renderer-initiated 1-step SPA history back (bypasses Chromium
      // WebView's UI-skip intervention on loadDataWithBaseURL + pushState).
      if (canStepBackInRouterHistory()) {
        global.history.back();
        return true;
      }

      // Priority 3b: Deep-link / __TSR_index === 0 fallback on nested sub-routes.
      if (clickParentBreadcrumb()) {
        return true;
      }
      if (
        global.location &&
        typeof global.location.pathname === 'string' &&
        global.location.pathname !== '/' &&
        global.location.pathname !== '' &&
        global.location.pathname !== '/index.html' &&
        typeof document !== 'undefined'
      ) {
        var homeBtn = findLastInteractable(document, MOBILE_HOME_BACK_SELECTOR);
        if (homeBtn && typeof homeBtn.click === 'function') {
          bypassMobileHomeIntercept = true;
          try {
            homeBtn.click();
          } finally {
            bypassMobileHomeIntercept = false;
          }
          return true;
        }
      }

      return false;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[AGY_BACK_NAV] handleBack error', e);
      }
      return false;
    }
  }

  global.__agHandleBack = handleBack;
}
