/**
 * patches/web_optimizations/gpu.js - GPU-accelerate scroll/animation surfaces,
 * isolate layout for lists, disable expensive mobile backdrop blurs, and
 * optimize mobile touch & plugin UI.
 */
function installGpu(doc) {
  try {
    if (!doc.querySelector('style[data-agy="gpu-acceleration"]')) {
      var gpu = doc.createElement('style');
      gpu.setAttribute('data-agy', 'gpu-acceleration');
      // Promote ONLY the real scroll containers with contain: layout style paint /
      // content-visibility for smooth scrolling on mid-range mobile GPUs.
      gpu.textContent =
        'main, [data-testid="chat-container"], .scrollable {' +
        ' -webkit-overflow-scrolling: touch;' +
        ' overscroll-behavior-y: contain;' +
        ' touch-action: pan-y pinch-zoom; }' +
        '[role="listitem"], .message-row, .artifact-viewer, .agy-sidebar-row {' +
        ' contain: layout style paint;' +
        ' content-visibility: auto;' +
        ' contain-intrinsic-size: auto 120px; }' +
        '*{ -webkit-tap-highlight-color: transparent; }' +
        /* Container-responsive Flexbox fixes for Plugin Accounts & MCP error rows:
         * Upstream uses flex-wrap + min-w-0 flex-1 (flex-basis: 0%) next to fixed-width
         * inputs/buttons (w-40 + Sign in = ~226px), so flex-wrap never triggers and text
         * collapses into a 40-90px tall vertical strip on phones and narrow split panes. */
        'section[aria-label="Accounts"] > div > div > div.flex-wrap > div.flex-1 {' +
        ' flex: 1 1 240px !important; min-width: min(100%, 240px) !important; }' +
        'section[aria-label="Accounts"] > div > div > div.flex-wrap > div.flex-1 > div.flex,' +
        'section[aria-label="Accounts"] ul[aria-label="Signed-in accounts"] > li > div.flex-1 > div.flex {' +
        ' flex-wrap: wrap; }' +
        'section[aria-label="Accounts"] ul[aria-label="Signed-in accounts"] > li > div.flex-1 {' +
        ' flex: 1 1 160px !important; min-width: min(100%, 160px) !important; }' +
        '[data-testid="mcp-server-row"] div.flex-wrap > div.flex-1 {' +
        ' flex: 1 1 200px !important; min-width: min(100%, 200px) !important; }' +
        /* Eliminate expensive full-screen backdrop blur passes on mid-range mobile GPUs */
        '@media (max-width: 768px), (pointer: coarse) {' +
        ' .surface-glass, .agy-fastpick.surface-glass, .quick-input-widget.surface-glass,' +
        ' .surface-composer > .surface-composer-card, [class*="backdrop-blur"] {' +
        '   -webkit-backdrop-filter: none !important;' +
        '   backdrop-filter: none !important; }' +
        ' body[data-agy-theme] .surface-glass,' +
        ' body[data-agy-theme] .agy-fastpick.surface-glass,' +
        ' body[data-agy-theme] .quick-input-widget.surface-glass {' +
        '   background-color: var(--card, #18181b) !important; }' +
        '}' +
        /* Mobile Customizations & Plugin / Sidecar UI Optimizations */
        '@media (max-width: 640px) {' +
        ' [data-testid="plugin-detail"] > div > div,' +
        ' [data-testid="bundle-detail"] > div > div {' +
        '   padding-left: 14px !important; padding-right: 14px !important; padding-top: 14px !important; }' +
        ' [data-testid="plugin-detail"] > div > div > div,' +
        ' [data-testid="bundle-detail"] > div > div > div {' +
        '   padding-left: 0 !important; padding-right: 0 !important; }' +
        ' section[aria-label="Accounts"] > div > div > div.flex-wrap {' +
        '   align-items: flex-start !important; }' +
        ' section[aria-label="Accounts"] div.flex.items-center:has(> input) {' +
        '   width: 100% !important; flex-wrap: wrap !important; }' +
        ' section[aria-label="Accounts"] div.flex.items-center:has(> input) > input {' +
        '   flex: 1 1 140px !important; width: auto !important; min-width: 0 !important; height: 32px !important; }' +
        ' section[aria-label="Accounts"] div.flex.items-center:has(> input) > button {' +
        '   height: 32px !important; }' +
        ' section[aria-label="Accounts"] p.truncate {' +
        '   white-space: normal !important; overflow-wrap: anywhere !important; }' +
        ' [data-testid="plugin-detail"] div.rounded-md.border.flex.items-center.justify-between,' +
        ' [data-testid="bundle-detail"] div.rounded-md.border.flex.items-center.justify-between,' +
        ' [data-testid="mcp-server-browser-sign-in"] {' +
        '   flex-wrap: wrap !important; gap: 8px !important; }' +
        ' [data-testid="plugin-detail"] div.rounded-md.border.flex.items-center.justify-between > div,' +
        ' [data-testid="bundle-detail"] div.rounded-md.border.flex.items-center.justify-between > div {' +
        '   flex: 1 1 200px !important; min-width: min(100%, 200px) !important; }' +
        ' [data-testid="mcp-server-browser-sign-in"] > span {' +
        '   flex: 1 1 100% !important; }' +
        ' [data-testid="plugin-detail"] div.flex.items-center:has(> h1),' +
        ' [data-testid="bundle-detail"] div.flex.items-center:has(> h1) {' +
        '   flex-wrap: wrap !important; row-gap: 4px !important; }' +
        ' [data-testid="plugin-detail"] div.flex.items-center > h1,' +
        ' [data-testid="bundle-detail"] div.flex.items-center > h1 {' +
        '   white-space: normal !important; overflow-wrap: anywhere !important; }' +
        ' [role="tablist"][aria-label="Plugin details"] {' +
        '   flex-wrap: nowrap !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch;' +
        '   scrollbar-width: none; padding-bottom: 4px; }' +
        ' [role="tablist"][aria-label="Plugin details"]::-webkit-scrollbar { display: none; }' +
        ' [data-testid="plugin-sidecar-modal"] {' +
        '   max-width: 100vw !important; }' +
        ' [data-testid="sidecar-side-panel-callout"] {' +
        '   flex-direction: column !important; align-items: stretch !important; gap: 10px !important; }' +
        ' [data-testid="sidecar-side-panel-callout"] button {' +
        '   width: 100% !important; justify-content: center !important; height: 32px !important; }' +
        ' [data-testid^="sidecar-row-"] {' +
        '   flex-direction: column !important; align-items: flex-start !important; gap: 2px !important; }' +
        ' [data-testid^="sidecar-row-"] > span:last-child {' +
        '   white-space: normal !important; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }' +
        ' [data-side-panel-open], [data-testid="aux-pane-split"], [data-side-panel-body] {' +
        '   width: 100% !important; max-width: 100vw !important; }' +
        ' [data-testid="side-panel-sash"], .side-panel-sash {' +
        '   display: none !important; }' +
        ' iframe[src*="swarm"], iframe[data-sidecar="swarm_board"] {' +
        '   width: 100% !important; height: 100% !important; border: 0 !important; }' +
        '}';
      (doc.head || doc.documentElement).appendChild(gpu);
    }
  } catch (e) {}
}
