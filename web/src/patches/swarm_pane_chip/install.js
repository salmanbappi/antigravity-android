/**
 * patches/swarm_pane_chip/install.js - Compact Swarm quick-open chip in the
 * chat composer toolbar ([data-agent-composer-root]) that opens or toggles
 * the upstream Swarm UI sidecar pane directly without modifying composer text.
 */
var global = typeof window !== 'undefined' ? window : this;

if (!global.__AG_SWARM_PANE_CHIP_INSTALLED__) {
  global.__AG_SWARM_PANE_CHIP_INSTALLED__ = true;

  var CHIP_ATTR = 'data-agy-swarm-chip';
  var CHIP_TEST_ID = 'agy-swarm-pane-chip';
  var STYLE_ID = 'agy-swarm-pane-chip-style';
  var DEBOUNCE_MS = 250;
  var lastClickAt = 0;
  var scanScheduled = false;

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById && document.getElementById(STYLE_ID)) return;
    var parent = document.head || document.documentElement;
    if (!parent || typeof document.createElement !== 'function') return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.agy-swarm-pane-chip{' +
        'display:inline-flex;align-items:center;justify-content:center;gap:4px;' +
        'flex-shrink:0;height:24px;padding:0 7px;border-radius:9999px;' +
        'border:1px solid var(--border,rgba(148,163,184,0.28));' +
        'background:var(--muted,rgba(148,163,184,0.14));' +
        'color:var(--foreground,inherit);' +
        'font-size:11px;font-weight:500;line-height:1;white-space:nowrap;' +
        'cursor:pointer;user-select:none;-webkit-user-select:none;' +
        '-webkit-tap-highlight-color:transparent;' +
        'transition:background-color 150ms ease,border-color 150ms ease,color 150ms ease,opacity 150ms ease;' +
      '}' +
      '.agy-swarm-pane-chip:hover{' +
        'border-color:var(--primary,#38bdf8);' +
        'color:var(--primary,#38bdf8);' +
      '}' +
      '.agy-swarm-pane-chip:active{opacity:0.78;}' +
      '.agy-swarm-pane-chip[data-swarm-open="true"]{' +
        'border-color:var(--primary,#38bdf8);' +
        'color:var(--primary,#38bdf8);' +
        'background:color-mix(in srgb,var(--primary,#38bdf8) 12%,var(--muted,transparent));' +
      '}' +
      '.agy-swarm-pane-chip svg{display:block;flex-shrink:0;}' +
      '@media (max-width:380px){' +
        '.agy-swarm-pane-chip{padding:0 6px;gap:3px;font-size:10.5px;}' +
      '}';
    parent.appendChild(style);
  }

  function resolvePanelScope() {
    var loc = global.location || {};
    var pathname = typeof loc.pathname === 'string' ? loc.pathname : '';
    var search = typeof loc.search === 'string' ? loc.search : '';
    var params = null;
    if (search && typeof global.URLSearchParams === 'function') {
      try {
        params = new global.URLSearchParams(search);
      } catch (ignored) {}
    }

    var ids = [];
    var m = pathname.match(/^\/c\/([^/]+)/);
    if (m && m[1]) {
      var decoded = m[1];
      try {
        decoded = decodeURIComponent(m[1]);
      } catch (ignored) {}
      ids = decoded.split('+').filter(Boolean);
    }
    if (ids.length === 0 && params) {
      var qCascade = params.get('cascadeId');
      if (qCascade) {
        ids = qCascade.split('+').filter(Boolean);
      }
    }

    var focused = params ? params.get('focused') : null;
    var activeId = (focused && ids.indexOf(focused) >= 0) ? focused : ids[0];
    if (activeId && activeId !== '_new') {
      return { kind: 'cascadeId', cascadeId: activeId };
    }

    var project = params ? params.get('project') : null;
    if (project) {
      return { kind: 'newConversation', projectId: project };
    }
    return { kind: 'home' };
  }

  function getPaneFromSlice(slice, panelScope) {
    if (!slice || !panelScope) return null;
    if (panelScope.kind === 'cascadeId') {
      return (slice.conversationPanes && slice.conversationPanes[panelScope.cascadeId]) || null;
    }
    if (panelScope.kind === 'newConversation') {
      return (slice.newConversationPanes && slice.newConversationPanes[panelScope.projectId]) || null;
    }
    if (panelScope.kind === 'home') {
      return slice.homePane || null;
    }
    return null;
  }

  function getFiberFromDom(el) {
    var cur = el;
    var depth = 0;
    while (cur && typeof cur === 'object' && depth < 20) {
      depth++;
      var keys = Object.keys(cur);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0) {
          return cur[k];
        }
      }
      cur = cur.parentElement || null;
    }
    return null;
  }

  function inspectFiberValue(val, ctx) {
    if (!val || typeof val !== 'object') return;
    if (!ctx.store && val.store && typeof val.store.getState === 'function' && typeof val.store.dispatch === 'function') {
      ctx.store = val.store;
    }
    if (!ctx.registry && typeof val.get === 'function') {
      try {
        if (val.get('extensibility') !== undefined || val.get('auxPaneComponent') !== undefined) {
          ctx.registry = val;
        }
      } catch (ignored) {}
    }
    if (!ctx.iframeCtx && typeof val.setIframeSrc === 'function' && typeof val.navigateIframe === 'function') {
      ctx.iframeCtx = val;
    }
  }

  function findReactContexts(anchorEl) {
    var ctx = { store: null, registry: null, iframeCtx: null };

    // Walk up from anchorEl (or first composer root) through ancestor Providers.
    var startEl = anchorEl || null;
    if (!startEl && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      startEl = document.querySelector('[data-agent-composer-root]') || document.getElementById('root');
    }
    var cur = getFiberFromDom(startEl);
    var steps = 0;
    while (cur && steps < 400) {
      steps++;
      if (cur.memoizedProps && cur.memoizedProps.value !== undefined) {
        inspectFiberValue(cur.memoizedProps.value, ctx);
        if (ctx.store && ctx.registry && ctx.iframeCtx) {
          return ctx;
        }
      }
      cur = cur.return || null;
    }

    // Fallback BFS down from #root container fiber if anything is still missing.
    if ((!ctx.store || !ctx.registry) && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      var rootEl = document.getElementById('root');
      var rootFiber = getFiberFromDom(rootEl);
      if (rootFiber) {
        var queue = [rootFiber.current || rootFiber];
        var visited = 0;
        while (queue.length > 0 && visited < 120) {
          visited++;
          var node = queue.shift();
          if (!node) continue;
          if (node.memoizedProps && node.memoizedProps.value !== undefined) {
            inspectFiberValue(node.memoizedProps.value, ctx);
            if (ctx.store && ctx.registry && ctx.iframeCtx) {
              return ctx;
            }
          }
          if (node.child) queue.push(node.child);
          if (node.sibling) queue.push(node.sibling);
        }
      }
    }

    return ctx;
  }

  function findSwarmView(registry) {
    if (!registry || typeof registry.get !== 'function') return null;
    var ext = null;
    try {
      ext = registry.get('extensibility');
    } catch (ignored) {}
    if (!ext || !ext.provider || typeof ext.provider.getState !== 'function') return null;

    var sidecars = null;
    try {
      sidecars = ext.provider.getState();
    } catch (ignored) {}
    if (!Array.isArray(sidecars) || sidecars.length === 0) return null;

    var resolveUrl = typeof ext.resolveSidecarUrl === 'function'
      ? ext.resolveSidecarUrl
      : function (baseUrl, p) {
          return String(baseUrl || '').replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');
        };

    var views = [];
    for (var i = 0; i < sidecars.length; i++) {
      var sc = sidecars[i];
      if (!sc || !sc.baseUrl || !sc.config || !sc.config.uiConfig || !Array.isArray(sc.config.uiConfig.views)) {
        continue;
      }
      var uiCfg = sc.config.uiConfig;
      for (var j = 0; j < uiCfg.views.length; j++) {
        var v = uiCfg.views[j];
        if (!v) continue;
        views.push({
          sidecarId: String(sc.sidecarId || ''),
          path: String(v.path || ''),
          title: String(v.title || uiCfg.displayName || sc.sidecarId || 'Swarm'),
          url: resolveUrl(sc.baseUrl, v.path),
          entrypoint: v.entrypoint
        });
      }
    }
    if (views.length === 0) return null;

    function isAuxPane(v) {
      return v.entrypoint === 1 || v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' || v.entrypoint == null;
    }

    var auxViews = views.filter(isAuxPane);
    var pools = auxViews.length > 0 ? [auxViews, views] : [views];
    for (var p = 0; p < pools.length; p++) {
      var pool = pools[p];
      for (var a = 0; a < pool.length; a++) {
        if (/swarm/i.test(pool[a].sidecarId) && /swarm_board/i.test(pool[a].path)) return pool[a];
      }
      for (var b = 0; b < pool.length; b++) {
        if (/swarm/i.test(pool[b].sidecarId)) return pool[b];
      }
      for (var c = 0; c < pool.length; c++) {
        if (/swarm/i.test(pool[c].title)) return pool[c];
      }
    }
    return null;
  }

  function appendConversationId(url, cascadeId) {
    if (!url || !cascadeId) return url;
    try {
      var parsed = new URL(url);
      parsed.searchParams.set('conversationId', cascadeId);
      return parsed.toString();
    } catch (ignored) {
      return url;
    }
  }

  function isSwarmPaneOpen(anchorEl) {
    // 1. Check visible sidecar iframe slot in DOM.
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      var slots = document.querySelectorAll('[data-testid="sidecar-iframe-slot"][data-visible="true"]');
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i];
        var sid = (slot.getAttribute && slot.getAttribute('data-sidecar-id')) || '';
        var surl = (slot.getAttribute && slot.getAttribute('data-sidecar-url')) || '';
        if (/swarm/i.test(sid) || /swarm/i.test(surl)) {
          return true;
        }
      }
    }

    // 2. Check Redux sidePanel / sidePanelV2 state.
    var ctx = findReactContexts(anchorEl);
    if (ctx.store) {
      try {
        var state = ctx.store.getState();
        var panelScope = resolvePanelScope();
        var sp1 = getPaneFromSlice(state && state.sidePanel, panelScope);
        var sp2 = getPaneFromSlice(state && state.sidePanelV2, panelScope);
        var isOpen = Boolean(sp1 && sp1.isPaneOpen);
        var activeTabId = (sp2 && sp2.activeTabId) || (sp1 && sp1.activeTabId) || '';
        if (isOpen && /swarm/i.test(String(activeTabId))) {
          return true;
        }
      } catch (ignored) {}
    }

    return false;
  }

  function closeSwarmPane(anchorEl) {
    var ctx = findReactContexts(anchorEl);
    if (ctx.store) {
      try {
        var panelScope = resolvePanelScope();
        ctx.store.dispatch({
          type: 'sidePanel/setSidePanelOpen',
          payload: { panelScope: panelScope, isOpen: false }
        });
        return 'redux-close';
      } catch (ignored) {}
    }

    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      var toggleBtn =
        document.querySelector('[data-testid="mobile-toggle-aux-sidebar"]') ||
        document.querySelector('[data-testid="toggle-aux-sidebar"]') ||
        document.querySelector('button[aria-label="Toggle Side Panel"]');
      if (toggleBtn && typeof toggleBtn.click === 'function') {
        toggleBtn.click();
        return 'dom-close';
      }
    }

    return null;
  }

  function findDomSwarmTrigger() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }

    // 1. Explicit sidecar://swarm... anchor links if present.
    var links = document.querySelectorAll('a[href]');
    var lastLink = null;
    for (var i = 0; i < links.length; i++) {
      var href = (links[i].getAttribute && links[i].getAttribute('href')) || '';
      if (/^sidecar:\/\/.*swarm/i.test(href)) {
        lastLink = links[i];
      }
    }
    if (lastLink) return lastLink;

    // 2. Upstream inline sidecar pill buttons (Dlc -> Alc: button[data-quotable-inline="true"]).
    var pills = document.querySelectorAll('button[data-quotable-inline="true"]');
    var lastPill = null;
    for (var j = 0; j < pills.length; j++) {
      var btn = pills[j];
      if (btn.disabled || (btn.hasAttribute && btn.hasAttribute('disabled'))) continue;
      var text = String(btn.textContent || '');
      var title = (btn.getAttribute && btn.getAttribute('title')) || '';
      if (/swarm/i.test(text) || /swarm/i.test(title)) {
        lastPill = btn;
      }
    }
    if (lastPill) return lastPill;

    // 3. Plugins submenu item for Swarm if open in DOM.
    var menuItems = document.querySelectorAll('[data-testid="plugins-submenu-item"][data-sidecar-id]');
    for (var k = 0; k < menuItems.length; k++) {
      var sid = (menuItems[k].getAttribute && menuItems[k].getAttribute('data-sidecar-id')) || '';
      if (/swarm/i.test(sid)) return menuItems[k];
    }

    return null;
  }

  function openSwarmPane(anchorEl) {
    var ctx = findReactContexts(anchorEl);
    var panelScope = resolvePanelScope();

    // 1. Primary: Dispatch upstream sidecarView directly via Redux + extensibility registry.
    // Works reliably whether or not a sidecar://swarm/swarm_board link is currently in the DOM.
    if (ctx.store && ctx.registry) {
      var view = findSwarmView(ctx.registry);
      if (view) {
        try {
          var content = {
            type: 'sidecarView',
            sidecarView: {
              sidecarId: view.sidecarId,
              path: view.path,
              url: view.url,
              title: view.title
            }
          };
          var tabId = 'sidecar__' + view.sidecarId + '__' + view.path;
          if (ctx.iframeCtx && view.url) {
            try {
              var scopedUrl = appendConversationId(
                view.url,
                panelScope.kind === 'cascadeId' ? panelScope.cascadeId : ''
              );
              ctx.iframeCtx.setIframeSrc(scopedUrl, scopedUrl);
            } catch (ignored) {}
          }
          var auxCfg = null;
          try {
            auxCfg = ctx.registry.get('auxPaneComponent');
          } catch (ignored) {}
          var state = ctx.store.getState ? ctx.store.getState() : null;
          var useV2 = Boolean((auxCfg && auxCfg.redesignEnabled === true) || (state && state.sidePanelV2));
          ctx.store.dispatch({
            type: useV2 ? 'sidePanelV2/setContent' : 'sidePanel/setContent',
            payload: { panelScope: panelScope, content: content, tabId: tabId }
          });
          ctx.store.dispatch({
            type: 'sidePanel/setSidePanelOpen',
            payload: { panelScope: panelScope, isOpen: true }
          });
          return 'redux-sidecar';
        } catch (ignored) {}
      }
    }

    // 2. Fallback: Click an existing Swarm sidecar pill/link in the chat DOM.
    var domTrigger = findDomSwarmTrigger();
    if (domTrigger && typeof domTrigger.click === 'function') {
      domTrigger.click();
      return 'dom-link';
    }

    // 3. Fallback: Re-activate an existing Swarm sidecar tab already stored in Redux.
    if (ctx.store) {
      try {
        var st = ctx.store.getState();
        var sp2 = getPaneFromSlice(st && st.sidePanelV2, panelScope);
        var sp1 = getPaneFromSlice(st && st.sidePanel, panelScope);
        var tabs = (sp2 && Array.isArray(sp2.tabs) && sp2.tabs) || (sp1 && Array.isArray(sp1.tabs) && sp1.tabs) || [];
        var swarmTab = null;
        for (var i = 0; i < tabs.length; i++) {
          var t = tabs[i];
          if (t && /swarm/i.test(String(t.id || ''))) {
            swarmTab = t;
            break;
          }
        }
        if (swarmTab) {
          var useV2Tab = Boolean(sp2 && Array.isArray(sp2.tabs) && sp2.tabs.indexOf(swarmTab) >= 0);
          ctx.store.dispatch({
            type: useV2Tab ? 'sidePanelV2/setActiveTab' : 'sidePanel/setActiveTab',
            payload: { panelScope: panelScope, tabId: swarmTab.id }
          });
          ctx.store.dispatch({
            type: 'sidePanel/setSidePanelOpen',
            payload: { panelScope: panelScope, isOpen: true }
          });
          return 'redux-existing-tab';
        }
      } catch (ignored) {}
    }

    // 4. Last-resort fallback: if a hidden Swarm iframe slot already exists, toggle the side panel open.
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      var hiddenSlot = document.querySelector('[data-testid="sidecar-iframe-slot"][data-sidecar-id*="swarm" i]');
      if (hiddenSlot) {
        var toggleBtn =
          document.querySelector('[data-testid="mobile-toggle-aux-sidebar"]') ||
          document.querySelector('[data-testid="toggle-aux-sidebar"]') ||
          document.querySelector('button[aria-label="Toggle Side Panel"]');
        if (toggleBtn && typeof toggleBtn.click === 'function') {
          toggleBtn.click();
          return 'dom-toggle';
        }
      }
    }

    return null;
  }

  function syncChipStates() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var chips = document.querySelectorAll('[' + CHIP_ATTR + '="true"]');
    if (!chips || chips.length === 0) return;
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var open = isSwarmPaneOpen(chip);
      if (chip.setAttribute) {
        chip.setAttribute('data-swarm-open', open ? 'true' : 'false');
        chip.setAttribute('aria-pressed', open ? 'true' : 'false');
      }
    }
  }

  function toggleSwarmPane(anchorEl) {
    var now = Date.now();
    if (now - lastClickAt < DEBOUNCE_MS) {
      return 'debounced';
    }
    lastClickAt = now;

    var result = isSwarmPaneOpen(anchorEl)
      ? closeSwarmPane(anchorEl)
      : openSwarmPane(anchorEl);

    if (typeof setTimeout === 'function') {
      setTimeout(syncChipStates, 40);
    }
    return result;
  }

  function createSwarmChip() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agy-swarm-pane-chip shrink-0';
    btn.setAttribute(CHIP_ATTR, 'true');
    btn.setAttribute('data-testid', CHIP_TEST_ID);
    btn.setAttribute('aria-label', 'Toggle Swarm UI');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('data-swarm-open', 'false');
    btn.setAttribute('title', 'Open or toggle Swarm UI');
    btn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">' +
        '<polygon points="8,1.5 11.2,3.3 11.2,6.9 8,8.7 4.8,6.9 4.8,3.3" />' +
        '<polygon points="4.8,6.9 8,8.7 8,12.3 4.8,14.1 1.6,12.3 1.6,8.7" />' +
        '<polygon points="11.2,6.9 14.4,8.7 14.4,12.3 11.2,14.1 8,12.3 8,8.7" />' +
      '</svg>' +
      '<span>Swarm</span>';

    btn.addEventListener('click', function (e) {
      if (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
      }
      toggleSwarmPane(btn);
    });

    return btn;
  }

  function injectIntoComposer(composerRoot) {
    if (!composerRoot || typeof composerRoot.querySelector !== 'function') return false;
    // Skip secondary composers nested inside the side panel itself.
    if (typeof composerRoot.closest === 'function' && composerRoot.closest('[data-side-panel-focus-scope="true"]')) {
      return false;
    }
    if (composerRoot.querySelector('[' + CHIP_ATTR + '="true"]')) {
      return false;
    }

    ensureStyles();
    var chip = createSwarmChip();

    // Insert directly before the right-hand shrink-0 controls group so the
    // flex-1 min-w-0 left group shrinks cleanly on 360px mobile screens and
    // React's reconciliation inside each group remains untouched.
    var children = composerRoot.children || [];
    if (children.length >= 2 && typeof composerRoot.insertBefore === 'function') {
      composerRoot.insertBefore(chip, children[children.length - 1]);
    } else if (typeof composerRoot.appendChild === 'function') {
      composerRoot.appendChild(chip);
    }
    return true;
  }

  function scanComposers() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return 0;
    var roots = document.querySelectorAll('[data-agent-composer-root]');
    var added = 0;
    for (var i = 0; i < roots.length; i++) {
      if (injectIntoComposer(roots[i])) {
        added++;
      }
    }
    syncChipStates();
    return added;
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    var run = function () {
      scanScheduled = false;
      scanComposers();
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(run);
    } else if (typeof setTimeout === 'function') {
      setTimeout(run, 30);
    } else {
      run();
    }
  }

  function boot() {
    ensureStyles();
    scanComposers();
    if (typeof global.MutationObserver === 'function' && typeof document !== 'undefined') {
      var target = document.body || document.documentElement;
      if (target) {
        var obs = new global.MutationObserver(scheduleScan);
        obs.observe(target, { childList: true, subtree: true });
      }
    }
  }

  global.__agSwarmPaneChip = {
    toggle: toggleSwarmPane,
    isOpen: isSwarmPaneOpen,
    scan: scanComposers,
    resolvePanelScope: resolvePanelScope,
    findSwarmView: findSwarmView
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
}
