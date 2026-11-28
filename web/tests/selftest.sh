#!/usr/bin/env bash
# Build web assets on a disposable copy and prove upstream main.js stays intact.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="${TMPDIR:-${HOME:-.}/.tmp}"
mkdir -p "$TMP_DIR"
TMP="$(mktemp -d "$TMP_DIR/agy-web-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp -a "$ROOT/web" "$TMP/web"
before="$(sha256sum "$TMP/web/main.js" | cut -d' ' -f1)"
bash "$TMP/web/build.sh"
after="$(sha256sum "$TMP/web/main.js" | cut -d' ' -f1)"
[ "$before" = "$after" ] || { echo "web/build.sh modified source main.js" >&2; exit 1; }
[ -s "$TMP/web/generated/main.js" ] || { echo "generated/main.js missing" >&2; exit 1; }
grep -Fq 'src="./generated/main.js"' "$TMP/web/index.html"

# Verify no double IIFE wrappers in generated bundles (excluding vendor main.js)
for f in "$TMP"/web/generated/boot/*.js "$TMP"/web/generated/patches/*.js; do
    [ -f "$f" ] || continue
    if awk '
        BEGIN { iife_opens = 0; in_block = 0 }
        {
            line = $0
            if (in_block) {
                if (line ~ /\*\//) { sub(/^.*\*\//, "", line); in_block = 0 }
                else next
            }
            if (line ~ /\/\*/) { sub(/\/\*.*$/, "", line); in_block = 1 }
            sub(/^[ \t]+/, "", line)
            if (line ~ /^\(function/) iife_opens++
        }
        END { if (iife_opens > 1) exit 0; exit 1 }
    ' "$f"; then
        echo "Double IIFE wrapper detected in $f" >&2
        exit 1
    fi
done

# Behavioral test: agy:host-resume force-resets stalled streaming RPCs without
# aborting caller signal or touching unary/audio RPCs, and defers while hidden.
if command -v node >/dev/null 2>&1; then
    node - "$TMP/web/generated/bridge.core.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = listeners.get(ev.type);
      if (!set) return true;
      for (const fn of [...set]) fn(ev);
      return true;
    }
  };
}

async function run() {
  const winTarget = makeEventTarget();
  const docTarget = makeEventTarget();
  const mockDoc = {
    visibilityState: 'visible',
    addEventListener: docTarget.addEventListener,
    removeEventListener: docTarget.removeEventListener,
    dispatchEvent: docTarget.dispatchEvent
  };

  let fakeNow = 100000;
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const fetchCalls = [];
  function mockOrigFetch(url, opts) {
    const call = { url: String(url), opts: opts || {}, aborted: false };
    fetchCalls.push(call);
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => { call.aborted = true; });
    }
    if (call.url.includes('SendUserCascadeMessage')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    // Streaming response whose reader stays pending indefinitely until cancelled/errored.
    const body = new ReadableStream({
      start() {},
      pull() {
        return new Promise(() => {});
      }
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date: FakeDate,
    URL,
    Headers,
    Response,
    Request,
    ReadableStream,
    AbortController,
    DOMException,
    Event,
    CustomEvent,
    fetch: mockOrigFetch,
    document: mockDoc,
    navigator: {},
    location: { origin: 'https://127.0.0.1:45157', href: 'https://127.0.0.1:45157/', search: '' },
    __AG_CONFIG__: { coreBase: 'https://127.0.0.1:45157', csrfToken: 'test-csrf' },
    addEventListener: winTarget.addEventListener,
    removeEventListener: winTarget.removeEventListener,
    dispatchEvent: winTarget.dispatchEvent
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(code, sandbox);

  // 1. Open a stalled StreamAgentStateUpdates stream, a unary RPC, and an audio stream.
  const callerCtrl = new AbortController();
  const streamResp = await sandbox.fetch(
    'https://127.0.0.1:45157/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
    { method: 'POST', signal: callerCtrl.signal, body: '{}' }
  );
  const streamReader = streamResp.body.getReader();
  const pendingRead = streamReader.read();

  const audioCtrl = new AbortController();
  const audioResp = await sandbox.fetch(
    'https://127.0.0.1:45157/exa.language_server_pb.LanguageServerService/StreamAudioTranscription',
    { method: 'POST', signal: audioCtrl.signal, body: '{}' }
  );
  assert.strictEqual(audioResp.status, 200);

  const unaryCtrl = new AbortController();
  const unaryResp = await sandbox.fetch(
    'https://127.0.0.1:45157/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    { method: 'POST', signal: unaryCtrl.signal, body: '{}' }
  );
  assert.strictEqual(unaryResp.status, 200);

  // Advance clock past grace window (5s backgrounded).
  fakeNow += 5000;

  // 2. Dispatch agy:host-resume while document is still 'hidden': must defer, not burn cooldown.
  mockDoc.visibilityState = 'hidden';
  let recoverEvents = [];
  sandbox.addEventListener('agy:stream-recover', (ev) => recoverEvents.push(ev.detail));
  sandbox.dispatchEvent(new CustomEvent('agy:host-resume', { detail: { backgroundMs: 5000, wasStopped: true } }));
  assert.strictEqual(recoverEvents.length, 0, 'should defer recovery while document is hidden');
  assert.strictEqual(fetchCalls[0].aborted, false, 'should not abort stream while still hidden');

  // 3. Transition document to 'visible' -> deferred recovery fires and resets StreamAgentStateUpdates.
  mockDoc.visibilityState = 'visible';
  mockDoc.dispatchEvent(new Event('visibilitychange'));

  let readErr = null;
  try {
    await pendingRead;
  } catch (err) {
    readErr = err;
  }
  assert(readErr, 'stalled StreamAgentStateUpdates reader.read() must reject on resume');
  assert.strictEqual(readErr.name, 'AbortError', 'rejection should be AbortError');
  assert.strictEqual(callerCtrl.signal.aborted, false, 'caller signal must stay unaborted so kda reconnects');
  assert.strictEqual(fetchCalls[0].aborted, true, 'inner fetch controller for StreamAgentStateUpdates must abort');
  assert.strictEqual(fetchCalls[1].aborted, false, 'StreamAudioTranscription must not be aborted');
  assert.strictEqual(fetchCalls[2].aborted, false, 'unary SendUserCascadeMessage must not be aborted');
  assert.strictEqual(recoverEvents.length, 1, 'should fire one agy:stream-recover event');
  assert.strictEqual(recoverEvents[0].resetCount, 1, 'should report 1 reset stream');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF

    # Behavioral test: __agHandleBack() handles ancestor z-index overlays, Back/Close/Escape,
    # in-layout controls, SPA window.history.back() (__TSR_index > 0), breadcrumbs, and Home exit.
    node - "$TMP/web/generated/patches/back_navigation.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

function makeNode(opts) {
  const attrs = Object.assign({}, opts.attrs || {});
  const node = {
    tagName: (opts.tagName || 'DIV').toUpperCase(),
    className: opts.className || '',
    disabled: Boolean(opts.disabled),
    tabIndex: typeof opts.tabIndex === 'number' ? opts.tabIndex : -1,
    style: Object.assign({ display: 'block', visibility: 'visible', zIndex: 'auto' }, opts.style || {}),
    rect: opts.rect || { width: 100, height: 40 },
    parent: null,
    parentElement: null,
    children: [],
    clicks: 0,
    events: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getBoundingClientRect() {
      return this.rect;
    },
    click() {
      this.clicks += 1;
    },
    dispatchEvent(ev) {
      this.events.push(ev);
      return true;
    },
    matches(sel) {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.some((p) => matchSimple(this, p));
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parent;
      }
      return null;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length > 0 ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      function walk(n) {
        for (const ch of n.children) {
          if (ch.matches(sel)) out.push(ch);
          walk(ch);
        }
      }
      walk(this);
      return out;
    },
    append(...kids) {
      for (const k of kids) {
        k.parent = this;
        k.parentElement = this;
        this.children.push(k);
      }
      return this;
    },
    removeChild(kid) {
      const idx = this.children.indexOf(kid);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        kid.parent = null;
        kid.parentElement = null;
      }
    }
  };
  return node;
}

function matchSimple(el, sel) {
  if (sel === '[inert]') return el.hasAttribute('inert');
  if (sel === '[aria-hidden="true"]') return el.getAttribute('aria-hidden') === 'true';
  if (sel === '[data-closed]') return el.hasAttribute('data-closed');
  if (sel === '[data-bottom-sheet-popup]:not([data-closed])') {
    return el.hasAttribute('data-bottom-sheet-popup') && !el.hasAttribute('data-closed');
  }
  if (sel === '.settings-modal-container:not([aria-hidden="true"])') {
    return el.className.split(/\s+/).includes('settings-modal-container') &&
      el.getAttribute('aria-hidden') !== 'true';
  }
  if (sel === '[role="dialog"]:not([data-closed])') {
    return el.getAttribute('role') === 'dialog' && !el.hasAttribute('data-closed');
  }
  if (sel === '[role="alertdialog"]:not([data-closed])') {
    return el.getAttribute('role') === 'alertdialog' && !el.hasAttribute('data-closed');
  }
  if (sel === '[role="menu"][data-open]') {
    return el.getAttribute('role') === 'menu' && el.hasAttribute('data-open');
  }
  if (sel === '[role="listbox"][data-open]') {
    return el.getAttribute('role') === 'listbox' && el.hasAttribute('data-open');
  }
  if (sel === 'button[aria-label="Back"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('aria-label') === 'Back' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === 'button[aria-label="Close"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('aria-label') === 'Close' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === 'button[aria-label="Close Logs Modal"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('aria-label') === 'Close Logs Modal' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === 'button[aria-label="Close Sidebar"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('aria-label') === 'Close Sidebar' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === 'button[data-testid="onboarding-back"][aria-label="Back"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('data-testid') === 'onboarding-back' &&
      el.getAttribute('aria-label') === 'Back' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === 'nav[aria-label="Breadcrumb"]') {
    return el.tagName === 'NAV' && el.getAttribute('aria-label') === 'Breadcrumb';
  }
  if (sel === '[data-testid="breadcrumb-segment"]') {
    return el.getAttribute('data-testid') === 'breadcrumb-segment';
  }
  if (sel === '[data-testid="mobile-back-to-home"]') {
    return el.getAttribute('data-testid') === 'mobile-back-to-home';
  }
  if (sel === 'button[data-testid="mobile-back-to-home"]:not([disabled])') {
    return el.tagName === 'BUTTON' &&
      el.getAttribute('data-testid') === 'mobile-back-to-home' &&
      !el.disabled && !el.hasAttribute('disabled');
  }
  if (sel === '[data-testid^="settings-nav-item-"]') {
    const id = el.getAttribute('data-testid') || '';
    return id.startsWith('settings-nav-item-');
  }
  if (sel === '[data-testid="settings-disabled-notice"]') {
    return el.getAttribute('data-testid') === 'settings-disabled-notice';
  }
  return false;
}

function createEnv(init) {
  const docRoot = makeNode({ tagName: 'BODY' });
  let historyBacks = 0;
  let fakeNow = 50000;
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;
  const docListeners = new Map();
  const loc = Object.assign({ pathname: '/', search: '' }, (init && init.location) || {});
  const hist = {
    state: (init && init.historyState !== undefined) ? init.historyState : { __TSR_index: 0 },
    back() {
      historyBacks += 1;
    }
  };
  const sandbox = {
    console,
    Date: FakeDate,
    URLSearchParams,
    location: loc,
    history: hist,
    document: {
      querySelector: (sel) => docRoot.querySelector(sel),
      querySelectorAll: (sel) => docRoot.querySelectorAll(sel),
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
      dispatchEvent: (ev) => {
        docRoot.dispatchEvent(ev);
        const list = docListeners.get(ev.type) || [];
        for (const fn of [...list]) fn(ev);
        return !ev.defaultPrevented;
      }
    },
    getComputedStyle: (el) => el.style
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return {
    sandbox,
    docRoot,
    location: loc,
    history: hist,
    getHistoryBacks: () => historyBacks,
    fireMobileBackTap(target, holdMs) {
      const downEv = { type: 'pointerdown', target };
      sandbox.document.dispatchEvent(downEv);
      fakeNow += holdMs || 0;
      const clickEv = {
        type: 'click',
        target,
        defaultPrevented: false,
        stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; }
      };
      sandbox.document.dispatchEvent(clickEv);
      return clickEv;
    }
  };
}

// 1. Clean Home ('/') with no overlay -> 'exit' (even if __TSR_index > 0 after mobile-back-to-home).
{
  const env = createEnv({ location: { pathname: '/', search: '?hostTheme=dark' }, historyState: { __TSR_index: 3 } });
  assert.strictEqual(typeof env.sandbox.__agHandleBack, 'function', '__agHandleBack must be exposed');
  assert.strictEqual(env.sandbox.__agHandleBack(), 'exit', 'clean Home should signal exit');
  assert.strictEqual(env.getHistoryBacks(), 0, 'clean Home must not call history.back()');
}

// 2. Settings desktop root (depth 0, no Back button):
//    - without router history -> false;
//    - with ?settingsOpen=true & __TSR_index > 0 -> pops via history.back() and returns true.
{
  const env = createEnv({ location: { pathname: '/', search: '?settingsOpen=true' }, historyState: { __TSR_index: 0 } });
  const settingsModal = makeNode({ className: 'settings-modal-container', style: { zIndex: '50' } });
  const settingsClose = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close' } });
  settingsModal.append(settingsClose);
  env.docRoot.append(settingsModal);

  assert.strictEqual(env.sandbox.__agHandleBack(), false, 'settings root at __TSR_index=0 should return false');
  assert.strictEqual(settingsClose.clicks, 0, 'settings root must not click replace:true Close');

  env.history.state = { __TSR_index: 1 };
  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'settings root at __TSR_index>0 should pop history');
  assert.strictEqual(env.getHistoryBacks(), 1, 'settings root should call window.history.back()');
  assert.strictEqual(settingsClose.clicks, 0, 'settings root must not click Close when popping history');
}

// 3. Nested Back buttons + inert panel + hidden button inside Settings:
//    clicks deepest active Back button, skips inert & display:none.
{
  const env = createEnv({ location: { pathname: '/', search: '?settingsOpen=true' }, historyState: { __TSR_index: 1 } });
  const sheetWrap = makeNode({ style: { zIndex: '4001' } });
  const settingsSheet = makeNode({
    attrs: { 'data-bottom-sheet-popup': '', 'data-sheet-depth': '0' }
  });
  const navMarker = makeNode({ attrs: { 'data-testid': 'settings-nav-item-General' } });
  const outerPanel = makeNode({});
  const btnOuter = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Back' } });
  outerPanel.append(btnOuter);
  const nestedPanel = makeNode({});
  const btnNested = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Back' } });
  nestedPanel.append(btnNested);
  const inertPanel = makeNode({ attrs: { inert: '' } });
  const btnInert = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Back' } });
  inertPanel.append(btnInert);
  const hiddenPanel = makeNode({});
  const btnHidden = makeNode({
    tagName: 'BUTTON',
    attrs: { 'aria-label': 'Back' },
    style: { display: 'none' }
  });
  hiddenPanel.append(btnHidden);
  settingsSheet.append(navMarker, outerPanel, nestedPanel, inertPanel, hiddenPanel);
  sheetWrap.append(settingsSheet);
  env.docRoot.append(sheetWrap);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'nested visible Back button should be handled');
  assert.strictEqual(btnNested.clicks, 1, 'deepest active Back button should be clicked');
  assert.strictEqual(btnOuter.clicks, 0, 'outer Back button should not be clicked first');
  assert.strictEqual(btnInert.clicks, 0, 'inert panel Back button must be skipped');
  assert.strictEqual(btnHidden.clicks, 0, 'hidden Back button must be skipped');

  // 4. Ancestor z-index stacking: <HI> dialog (wrapper zIndex: 5000, popup zIndex: auto)
  //    opened over Settings bottom sheet (wrapper zIndex: 4001, popup zIndex: auto)
  //    must win and click dialog's Close button without touching Settings Back or history.
  const modalWrap = makeNode({ style: { zIndex: '5000' } });
  const hiDialog = makeNode({ attrs: { role: 'dialog' } });
  const inertBackWrap = makeNode({ attrs: { inert: '' } });
  const inertDialogBack = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Back' } });
  inertBackWrap.append(inertDialogBack);
  const hiClose = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close' } });
  hiDialog.append(inertBackWrap, hiClose);
  modalWrap.append(hiDialog);
  // Prepend before sheetWrap to prove ancestor z-index (5000 > 4001) beats DOM order!
  env.docRoot.children.unshift(modalWrap);
  modalWrap.parent = env.docRoot;
  modalWrap.parentElement = env.docRoot;

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'higher ancestor z-index dialog should be handled');
  assert.strictEqual(hiClose.clicks, 1, 'dialog Close button should be clicked');
  assert.strictEqual(inertDialogBack.clicks, 0, 'inert dialog Back button must be skipped');
  assert.strictEqual(btnNested.clicks, 1, 'lower Settings Back button must not be clicked');
  assert.strictEqual(env.getHistoryBacks(), 0, 'closing dialog must not pop history');
}

// 5. Customizations in-page modals (J5 skill detail / ybd Add MCP) close via Close without popping route.
{
  const env = createEnv({
    location: { pathname: '/customizations/installed', search: '' },
    historyState: { __TSR_index: 2 }
  });
  const modalWrap = makeNode({ style: { zIndex: '5000' } });
  const skillModal = makeNode({ attrs: { role: 'dialog' } });
  const closeBtn = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close' } });
  skillModal.append(closeBtn);
  modalWrap.append(skillModal);
  env.docRoot.append(modalWrap);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'Customizations modal should close on Back');
  assert.strictEqual(closeBtn.clicks, 1, 'Customizations modal Close button should be clicked');
  assert.strictEqual(env.getHistoryBacks(), 0, 'closing modal must not navigate back');
}

// 6. Non-Settings bottom sheet (e.g. Mobile Side Panel Sod, which ALSO has role="dialog"
//    from Base UI Lvb, plus an inner tab Close button) must dismiss via Escape, NOT click
//    the inner tab Close button or pop history (even when ?feedbackOpen=true is present).
{
  const env = createEnv({
    location: { pathname: '/c/conv-1', search: '?feedbackOpen=true' },
    historyState: { __TSR_index: 2 }
  });
  const wrap = makeNode({ style: { zIndex: '6001' } });
  const sidePanelSheet = makeNode({
    attrs: { 'data-bottom-sheet-popup': '', 'data-sheet-depth': '0', role: 'dialog' }
  });
  const innerTabClose = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close' } });
  sidePanelSheet.append(innerTabClose);
  wrap.append(sidePanelSheet);
  env.docRoot.append(wrap);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'Mobile Side Panel sheet should be dismissed');
  assert.strictEqual(innerTabClose.clicks, 0, 'inner tab Close button must NOT be clicked');
  assert.strictEqual(sidePanelSheet.events.length, 1, 'Escape event must be dispatched on sheet');
  assert.strictEqual(sidePanelSheet.events[0].key, 'Escape', 'dispatched key must be Escape');
  assert.strictEqual(env.getHistoryBacks(), 0, 'dismissing bottom sheet must not pop Feedback/history');
}

// 7. Open [role="menu"][data-open] dismisses via Escape without popping route.
{
  const env = createEnv({
    location: { pathname: '/customizations', search: '' },
    historyState: { __TSR_index: 1 }
  });
  const menu = makeNode({ attrs: { role: 'menu', 'data-open': '' }, style: { zIndex: '50' } });
  env.docRoot.append(menu);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'open menu should dismiss on Back');
  assert.strictEqual(menu.events.length, 1, 'Escape event must be dispatched on menu');
  assert.strictEqual(menu.events[0].key, 'Escape');
  assert.strictEqual(env.getHistoryBacks(), 0);
}

// 8. Mobile overlay sidebar (<div role="dialog" aria-modal="true">) clicks Close Sidebar
//    even when an unrelated inner Close button precedes it; Onboarding Back works in-layout.
{
  const env = createEnv({
    location: { pathname: '/customizations', search: '' },
    historyState: { __TSR_index: 1 }
  });
  const sidebarDialog = makeNode({
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'false' },
    style: { zIndex: '50' }
  });
  const innerClose = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close' } });
  const closeSidebar = makeNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close Sidebar' } });
  sidebarDialog.append(innerClose, closeSidebar);
  env.docRoot.append(sidebarDialog);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'Close Sidebar dialog should be handled');
  assert.strictEqual(closeSidebar.clicks, 1, 'Close Sidebar must be clicked');
  assert.strictEqual(innerClose.clicks, 0, 'unrelated inner Close button must NOT be clicked');
  assert.strictEqual(env.getHistoryBacks(), 0);

  env.docRoot.removeChild(sidebarDialog);
  const onboardingBack = makeNode({
    tagName: 'BUTTON',
    attrs: { 'data-testid': 'onboarding-back', 'aria-label': 'Back' }
  });
  env.docRoot.append(onboardingBack);
  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'onboarding-back should be handled');
  assert.strictEqual(onboardingBack.clicks, 1);
}

// 9. Multi-step Customizations route (__TSR_index === 2 on /customizations/plugins/github)
//    steps back 1 entry via window.history.back() instead of falling back to webView.goBack().
{
  const env = createEnv({
    location: { pathname: '/customizations/plugins/github', search: '' },
    historyState: { __TSR_index: 2 }
  });
  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'Customizations detail with __TSR_index>0 must step back');
  assert.strictEqual(env.getHistoryBacks(), 1, 'must call window.history.back() once');
}

// 10. Deep-link / __TSR_index === 0 on /customizations/plugins/github uses parent breadcrumb
//     segment (never clicking leaf segment).
{
  const env = createEnv({
    location: { pathname: '/customizations/plugins/github', search: '' },
    historyState: { __TSR_index: 0 }
  });
  const nav = makeNode({ tagName: 'NAV', attrs: { 'aria-label': 'Breadcrumb' } });
  const parentSeg = makeNode({
    tagName: 'SPAN',
    attrs: { 'data-testid': 'breadcrumb-segment', role: 'button' },
    tabIndex: 0
  });
  const leafSeg = makeNode({
    tagName: 'SPAN',
    attrs: { 'data-testid': 'breadcrumb-segment', role: 'button' },
    tabIndex: 0
  });
  nav.append(parentSeg, leafSeg);
  env.docRoot.append(nav);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'parent breadcrumb fallback should handle Back');
  assert.strictEqual(parentSeg.clicks, 1, 'parent breadcrumb segment should be clicked');
  assert.strictEqual(leafSeg.clicks, 0, 'leaf breadcrumb segment must never be clicked');
  assert.strictEqual(env.getHistoryBacks(), 0);
}

// 11. Deep-link / __TSR_index === 0 on /customizations (no breadcrumb) clicks mobile-back-to-home.
{
  const env = createEnv({
    location: { pathname: '/customizations', search: '' },
    historyState: { __TSR_index: 0 }
  });
  const homeBack = makeNode({
    tagName: 'BUTTON',
    attrs: { 'data-testid': 'mobile-back-to-home', 'aria-label': 'Back to home' }
  });
  env.docRoot.append(homeBack);

  assert.strictEqual(env.sandbox.__agHandleBack(), true, 'mobile-back-to-home fallback should handle Back');
  assert.strictEqual(homeBack.clicks, 1);
}

// 12. On-screen mobile-back-to-home button:
//     - Short tap on nested route (/customizations/plugins/github) with __TSR_index > 0 intercepts and calls history.back()
//     - Short tap on nested route with __TSR_index === 0 clicks parent breadcrumb segment
//     - Long-press (>= 450ms) on nested route passes through to native HR() Home jump
//     - Short tap on top-level routes (/customizations, /c/conv-1, /conversations/conv-1) passes through to native HR()
{
  // 12a. Nested route + __TSR_index > 0 -> intercepts & calls history.back()
  const env = createEnv({
    location: { pathname: '/customizations/plugins/github', search: '' },
    historyState: { __TSR_index: 2 }
  });
  const homeBack = makeNode({
    tagName: 'BUTTON',
    attrs: { 'data-testid': 'mobile-back-to-home', 'aria-label': 'Back to home' }
  });
  const iconChild = makeNode({ tagName: 'SPAN' });
  homeBack.append(iconChild);
  env.docRoot.append(homeBack);

  const shortTap = env.fireMobileBackTap(iconChild, 80);
  assert.strictEqual(shortTap.defaultPrevented, true, 'short tap on nested route must preventDefault');
  assert.strictEqual(shortTap.stopped, true, 'short tap on nested route must stopImmediatePropagation');
  assert.strictEqual(env.getHistoryBacks(), 1, 'short tap on nested route must call history.back()');

  // 12b. Long-press (>= 450ms) on nested route -> passthrough to Home
  const longTap = env.fireMobileBackTap(homeBack, 500);
  assert.strictEqual(longTap.defaultPrevented, false, 'long-press must not intercept');
  assert.strictEqual(longTap.stopped, false, 'long-press must pass through to native HR()');
  assert.strictEqual(env.getHistoryBacks(), 1, 'long-press must not call history.back()');

  // 12c. Nested route with __TSR_index === 0 -> clicks parent breadcrumb
  env.history.state = { __TSR_index: 0 };
  const nav = makeNode({ tagName: 'NAV', attrs: { 'aria-label': 'Breadcrumb' } });
  const parentSeg = makeNode({
    tagName: 'A',
    attrs: { 'data-testid': 'breadcrumb-segment' }
  });
  const leafSeg = makeNode({
    tagName: 'SPAN',
    attrs: { 'data-testid': 'breadcrumb-segment', 'aria-current': 'page' }
  });
  nav.append(parentSeg, leafSeg);
  env.docRoot.append(nav);
  const deepLinkTap = env.fireMobileBackTap(homeBack, 50);
  assert.strictEqual(deepLinkTap.defaultPrevented, true, 'deep-link nested tap must intercept via breadcrumb');
  assert.strictEqual(parentSeg.clicks, 1, 'deep-link nested tap must click parent breadcrumb');
  assert.strictEqual(leafSeg.clicks, 0);

  // 12d. Top-level pages (/customizations, /c/conv-1, /conversations/conv-1) -> passthrough to Home
  env.docRoot.removeChild(nav);
  env.history.state = { __TSR_index: 2 };
  for (const topPath of ['/customizations', '/c/conv-1', '/conversations/conv-1']) {
    env.location.pathname = topPath;
    const ev = env.fireMobileBackTap(homeBack, 60);
    assert.strictEqual(ev.defaultPrevented, false, 'top-level route ' + topPath + ' must pass through to Home');
    assert.strictEqual(ev.stopped, false, 'top-level route ' + topPath + ' must not stop propagation');
  }
  assert.strictEqual(env.getHistoryBacks(), 1, 'top-level passthroughs must not call history.back()');
}
EOF

    # Behavioral test: web_optimizations.js injects valid, balanced Plugins mobile & Flexbox CSS rules.
    node - "$TMP/web/generated/patches/web_optimizations.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');
const appended = [];
const mockDoc = {
  readyState: 'complete',
  head: {
    appendChild(node) {
      appended.push(node);
    }
  },
  documentElement: {
    style: { setProperty() {} },
    appendChild(node) {
      appended.push(node);
    }
  },
  querySelector() {
    return null;
  },
  createElement(tag) {
    const attrs = {};
    return {
      tagName: tag.toUpperCase(),
      textContent: '',
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k] || null; }
    };
  },
  addEventListener() {}
};
const sandbox = {
  console,
  document: mockDoc,
  navigator: { userAgent: 'Mozilla/5.0 Android' },
  innerHeight: 800,
  addEventListener() {},
  setTimeout,
  clearTimeout
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);

const gpuStyle = appended.find((n) => n.getAttribute('data-agy') === 'gpu-acceleration');
assert(gpuStyle, 'gpu-acceleration style element must be injected');
const css = gpuStyle.textContent;
assert(css.length > 0, 'gpu-acceleration CSS must be non-empty');

// Check brace balance
let depth = 0;
for (let i = 0; i < css.length; i++) {
  if (css[i] === '{') depth += 1;
  else if (css[i] === '}') depth -= 1;
  assert(depth >= 0, 'unbalanced closing brace in gpu.js CSS');
}
assert.strictEqual(depth, 0, 'unbalanced opening brace in gpu.js CSS');

// Verify key Plugins / Accounts selectors exist
for (const sel of [
  'section[aria-label="Accounts"] > div > div > div.flex-wrap > div.flex-1',
  'section[aria-label="Accounts"] ul[aria-label="Signed-in accounts"] > li > div.flex-1',
  '[data-testid="plugin-detail"]',
  '[data-testid="bundle-detail"]',
  '[data-testid="mcp-server-row"]',
  '[data-testid="mcp-server-browser-sign-in"]'
]) {
  assert(css.includes(sel), 'gpu.js CSS missing expected selector: ' + sel);
}
EOF

    # Behavioral test: github_device_auth.js scopes strictly to GitHub (Local), handles
    # initial sign-in, multi-account Add account, slow_down backoff, errors, and Cancel.
    node - "$TMP/web/generated/patches/github_device_auth.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

function makeNode(tag, opts) {
  const o = opts || {};
  const attrs = Object.assign({}, o.attrs || {});
  const listeners = new Map();
  let innerHtmlVal = '';
  const node = {
    tagName: tag.toUpperCase(),
    type: o.type || '',
    className: o.className || '',
    value: o.value || '',
    disabled: Boolean(o.disabled),
    textContent: o.textContent || '',
    parentElement: null,
    parent: null,
    children: [],
    ownerDocument: null,
    clicks: 0,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      const list = listeners.get(ev.type) || [];
      for (const fn of [...list]) fn(ev);
      return true;
    },
    click() {
      this.clicks += 1;
      this.dispatchEvent({ type: 'click', target: this });
    },
    appendChild(child) {
      if (child.parentElement && child.parentElement.children) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx >= 0) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = this;
      child.parent = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      return child;
    },
    get lastElementChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    matches(sel) {
      if (sel === 'section[aria-label="Accounts"]') {
        return this.tagName === 'SECTION' && this.getAttribute('aria-label') === 'Accounts';
      }
      if (sel === 'div') return this.tagName === 'DIV';
      if (sel === 'span') return this.tagName === 'SPAN';
      if (sel === 'button') return this.tagName === 'BUTTON';
      if (sel === 'ul[aria-label="Signed-in accounts"]') {
        return this.tagName === 'UL' && this.getAttribute('aria-label') === 'Signed-in accounts';
      }
      if (sel === 'a[href*="github.com/settings/tokens"]') {
        return this.tagName === 'A' && (this.getAttribute('href') || '').includes('github.com/settings/tokens');
      }
      if (sel === 'input[aria-label="Secret for github"]') {
        return this.tagName === 'INPUT' && this.getAttribute('aria-label') === 'Secret for github';
      }
      if (sel === 'input[aria-label="Secret for a new github account"]') {
        return this.tagName === 'INPUT' && this.getAttribute('aria-label') === 'Secret for a new github account';
      }
      if (sel === 'style[data-agy="github-device-auth"]') {
        return this.tagName === 'STYLE' && this.getAttribute('data-agy') === 'github-device-auth';
      }
      if (sel === '[data-agy-github-auth]') return this.hasAttribute('data-agy-github-auth');
      const m = /^\[data-agy-github-auth="([^"]+)"\]$/.exec(sel);
      if (m) return this.getAttribute('data-agy-github-auth') === m[1];
      return false;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      const list = this.querySelectorAll(sel);
      return list.length ? list[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      function walk(n) {
        for (const ch of n.children) {
          if (ch.matches(sel)) out.push(ch);
          walk(ch);
        }
      }
      walk(this);
      return out;
    }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return innerHtmlVal; },
    set(v) {
      innerHtmlVal = String(v);
      if (v === '') node.children.length = 0;
    }
  });
  return node;
}

function createHarness(opts) {
  const o = opts || {};
  const head = makeNode('head');
  const body = makeNode('body');
  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    head,
    body,
    documentElement: body,
    createElement(tag) {
      const n = makeNode(tag);
      n.ownerDocument = doc;
      return n;
    },
    querySelector(sel) {
      return head.querySelector(sel) || body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return [...head.querySelectorAll(sel), ...body.querySelectorAll(sel)];
    },
    addEventListener() {}
  };
  head.ownerDocument = doc;
  body.ownerDocument = doc;

  const bridgeCalls = { start: [], poll: [], open: [], copy: [], fetch: [] };
  const timers = [];
  let timerSeq = 0;
  let fakeNow = 1000000;

  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;

  const androidBridge = {
    startGitHubDeviceAuth(tok, reqId, scope) {
      bridgeCalls.start.push({ tok, reqId, scope });
    },
    pollGitHubDeviceAuth(tok, reqId, deviceCode) {
      bridgeCalls.poll.push({ tok, reqId, deviceCode });
    },
    openGitHubDevicePage(tok, uri) {
      bridgeCalls.open.push({ tok, uri });
      return true;
    },
    copyGitHubDeviceCode(tok, codeStr) {
      bridgeCalls.copy.push({ tok, codeStr });
      return true;
    }
  };

  const sandbox = {
    console,
    Date: FakeDate,
    Event,
    location: { pathname: o.pathname || '/customizations/plugins/github' },
    document: doc,
    navigator: {},
    fetch(url, init) {
      bridgeCalls.fetch.push({ url, init });
      return Promise.resolve({ ok: true, status: 200 });
    },
    __AG_NATIVE_BRIDGE_TOKEN__: 'bridge-secret-tok',
    Android: androidBridge,
    setTimeout(fn, ms) {
      const id = ++timerSeq;
      timers.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      for (const t of timers) {
        if (t.id === id) t.cleared = true;
      }
    },
    addEventListener() {},
    dispatchEvent() { return true; }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);

  return {
    sandbox,
    doc,
    body,
    bridgeCalls,
    timers,
    advanceTime(ms) { fakeNow += ms; },
    flushMicrotasks() { return new Promise((r) => setImmediate(r)); },
    runPendingTimers() {
      const ready = timers.filter((t) => !t.cleared);
      for (const t of ready) {
        t.cleared = true;
        t.fn();
      }
    }
  };
}

function buildProviderCard(doc, cfg) {
  const card = doc.createElement('div');
  card.className = 'rounded-md border border-border/60 p-3 space-y-3';
  const top = doc.createElement('div');
  top.className = 'flex flex-wrap items-center gap-3';
  const info = doc.createElement('div');
  info.className = 'min-w-0 flex-1';
  const hdr = doc.createElement('div');
  hdr.className = 'flex items-center gap-2';
  const nameSpan = doc.createElement('span');
  nameSpan.textContent = cfg.provider;
  const typeSpan = doc.createElement('span');
  typeSpan.textContent = cfg.typeLabel;
  hdr.appendChild(nameSpan);
  hdr.appendChild(typeSpan);
  info.appendChild(hdr);
  if (cfg.setupUrl) {
    const a = doc.createElement('a');
    a.setAttribute('href', cfg.setupUrl);
    info.appendChild(a);
  }
  top.appendChild(info);
  card.appendChild(top);
  return { card, top };
}

async function runTests() {
  // 1. Strict scoping: NEVER inject on Gmail (OAuth) or non-GitHub API key providers.
  {
    const h = createHarness({ pathname: '/customizations/plugins/gmail' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gmail = buildProviderCard(h.doc, { provider: 'google', typeLabel: 'OAuth' });
    const stripe = buildProviderCard(h.doc, { provider: 'stripe', typeLabel: 'API key' });
    list.appendChild(gmail.card);
    list.appendChild(stripe.card);
    sec.appendChild(list);
    h.body.appendChild(sec);
    h.sandbox.__agGitHubDeviceAuth.scan();

    assert.strictEqual(gmail.card.querySelector('[data-agy-github-auth="container"]'), null, 'must not inject on Gmail');
    assert.strictEqual(stripe.card.querySelector('[data-agy-github-auth="container"]'), null, 'must not inject on non-GitHub API key');
  }

  // 2. Initial sign-in flow: start -> auto-copy -> Open GitHub -> pending -> slow_down -> complete -> fills YXb input & clicks Sign in.
  {
    const h = createHarness({ pathname: '/customizations/plugins/github' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gh = buildProviderCard(h.doc, {
      provider: 'github',
      typeLabel: 'API key',
      setupUrl: 'https://github.com/settings/tokens'
    });
    const yxb = h.doc.createElement('div');
    const input = h.doc.createElement('input');
    input.type = 'password';
    input.setAttribute('aria-label', 'Secret for github');
    const signInBtn = h.doc.createElement('button');
    signInBtn.textContent = 'Sign in';
    signInBtn.disabled = true;
    input.addEventListener('input', () => {
      signInBtn.disabled = !input.value;
    });
    yxb.appendChild(input);
    yxb.appendChild(signInBtn);
    gh.top.appendChild(yxb);
    list.appendChild(gh.card);
    sec.appendChild(list);
    h.body.appendChild(sec);

    h.sandbox.__agGitHubDeviceAuth.scan();
    const startBtn = gh.card.querySelector('[data-agy-github-auth="signin-btn"]');
    assert(startBtn, 'Sign in with GitHub (Browser) button must be injected');
    startBtn.click();

    assert.strictEqual(h.bridgeCalls.start.length, 1);
    assert.strictEqual(h.bridgeCalls.start[0].tok, 'bridge-secret-tok');
    const startReqId = h.bridgeCalls.start[0].reqId;

    h.sandbox.__agGitHubDeviceAuthCallback(startReqId, JSON.stringify({
      ok: true,
      device_code: 'dev-code-123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5
    }));
    await h.flushMicrotasks();

    assert.strictEqual(h.bridgeCalls.copy.length, 1, 'must auto-copy user_code');
    assert.strictEqual(h.bridgeCalls.copy[0].codeStr, 'ABCD-1234');
    const codeEl = gh.card.querySelector('[data-agy-github-auth="user-code"]');
    assert(codeEl && codeEl.textContent === 'ABCD-1234', 'must render user_code');

    const openBtn = gh.card.querySelector('[data-agy-github-auth="open-btn"]');
    assert(openBtn, 'Open GitHub button must render');
    openBtn.click();
    assert.strictEqual(h.bridgeCalls.open.length, 1);
    assert.strictEqual(h.bridgeCalls.open[0].uri, 'https://github.com/login/device');

    // Poll 1: authorization_pending
    h.advanceTime(5000);
    h.runPendingTimers();
    assert.strictEqual(h.bridgeCalls.poll.length, 1);
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[0].reqId, JSON.stringify({
      ok: true, status: 'pending', error: 'authorization_pending'
    }));
    await h.flushMicrotasks();
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().intervalMs, 5000);

    // Poll 2: slow_down -> interval must increase
    h.advanceTime(5000);
    h.runPendingTimers();
    assert.strictEqual(h.bridgeCalls.poll.length, 2);
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[1].reqId, JSON.stringify({
      ok: true, status: 'slow_down', error: 'slow_down', interval: 10
    }));
    await h.flushMicrotasks();
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().intervalMs, 10000, 'slow_down must increase interval to 10s');

    // Poll 3: complete -> fills input and clicks Sign in (after deferred macrotask)
    h.advanceTime(10000);
    h.runPendingTimers();
    assert.strictEqual(h.bridgeCalls.poll.length, 3);
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[2].reqId, JSON.stringify({
      ok: true, status: 'complete', access_token: 'gho_test_token_xyz', token_type: 'bearer'
    }));
    await h.flushMicrotasks();
    h.runPendingTimers();
    h.runPendingTimers();

    assert.strictEqual(input.value, 'gho_test_token_xyz', 'must populate YXb password input');
    assert.strictEqual(signInBtn.clicks, 1, 'must click enabled Sign in button');
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().status, 'idle');
  }

  // 3. Multi-account Add account flow: clicks native "Add account", mounts new input, fills & clicks "Add".
  {
    const h = createHarness({ pathname: '/customizations/plugins/github' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gh = buildProviderCard(h.doc, {
      provider: 'github',
      typeLabel: 'API key',
      setupUrl: 'https://github.com/settings/tokens'
    });
    const ul = h.doc.createElement('ul');
    ul.setAttribute('aria-label', 'Signed-in accounts');
    gh.card.appendChild(ul);

    let mountedAddInput = null;
    let mountedAddSubmit = null;
    const nativeAddBtn = h.doc.createElement('button');
    nativeAddBtn.textContent = 'Add account';
    nativeAddBtn.addEventListener('click', () => {
      const yxb = h.doc.createElement('div');
      mountedAddInput = h.doc.createElement('input');
      mountedAddInput.type = 'password';
      mountedAddInput.setAttribute('aria-label', 'Secret for a new github account');
      mountedAddSubmit = h.doc.createElement('button');
      mountedAddSubmit.textContent = 'Add';
      mountedAddSubmit.disabled = true;
      mountedAddInput.addEventListener('input', () => {
        mountedAddSubmit.disabled = !mountedAddInput.value;
      });
      yxb.appendChild(mountedAddInput);
      yxb.appendChild(mountedAddSubmit);
      gh.card.appendChild(yxb);
    });
    gh.card.appendChild(nativeAddBtn);
    list.appendChild(gh.card);
    sec.appendChild(list);
    h.body.appendChild(sec);

    h.sandbox.__agGitHubDeviceAuth.scan();
    const addGhBtn = gh.card.querySelector('[data-agy-github-auth="add-btn"]');
    assert(addGhBtn, 'Add account with GitHub (Browser) button must be injected when accounts exist');
    addGhBtn.click();

    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.start[0].reqId, JSON.stringify({
      ok: true, device_code: 'dev-2', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5
    }));
    await h.flushMicrotasks();
    h.advanceTime(5000);
    h.runPendingTimers();

    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[0].reqId, JSON.stringify({
      ok: true, status: 'complete', access_token: 'gho_second_account_tok'
    }));
    await h.flushMicrotasks();
    h.runPendingTimers();
    h.runPendingTimers();

    assert.strictEqual(nativeAddBtn.clicks, 1, 'must click native Add account button to reveal YXb');
    assert(mountedAddInput, 'new account input must mount');
    assert.strictEqual(mountedAddInput.value, 'gho_second_account_tok');
    assert.strictEqual(mountedAddSubmit.clicks, 1, 'must click Add submit button');
  }

  // 4. Cancel ignores stale callbacks & error states (expired_token, access_denied) stop polling cleanly.
  {
    const h = createHarness({ pathname: '/customizations/plugins/github' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gh = buildProviderCard(h.doc, {
      provider: 'github',
      typeLabel: 'API key',
      setupUrl: 'https://github.com/settings/tokens'
    });
    list.appendChild(gh.card);
    sec.appendChild(list);
    h.body.appendChild(sec);
    h.sandbox.__agGitHubDeviceAuth.scan();

    gh.card.querySelector('[data-agy-github-auth="signin-btn"]').click();
    const cancelBtn = gh.card.querySelector('[data-agy-github-auth="cancel-btn"]');
    cancelBtn.click();
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().status, 'idle');

    // Late start response for canceled flow must be ignored
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.start[0].reqId, JSON.stringify({
      ok: true, device_code: 'stale', user_code: 'STAL-0000', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5
    }));
    await h.flushMicrotasks();
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().status, 'idle', 'canceled flow must ignore late callback');

    // access_denied stops polling cleanly
    gh.card.querySelector('[data-agy-github-auth="signin-btn"]').click();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.start[1].reqId, JSON.stringify({
      ok: true, device_code: 'dev-deny', user_code: 'DENY-1111', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5
    }));
    await h.flushMicrotasks();
    h.advanceTime(5000);
    h.runPendingTimers();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[0].reqId, JSON.stringify({
      ok: true, status: 'error', error: 'access_denied'
    }));
    await h.flushMicrotasks();
    assert.strictEqual(h.sandbox.__agGitHubDeviceAuth.getState().status, 'error');
    assert(h.sandbox.__agGitHubDeviceAuth.getState().error.includes('canceled'));
  }

  // 5. Regression: pre-filled PAT input + React 18 async microtask state commit must submit fresh token, not stale value.
  {
    const h = createHarness({ pathname: '/customizations/plugins/github' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gh = buildProviderCard(h.doc, {
      provider: 'github',
      typeLabel: 'API key',
      setupUrl: 'https://github.com/settings/tokens'
    });
    const yxb = h.doc.createElement('div');
    const input = h.doc.createElement('input');
    input.type = 'password';
    input.value = 'stale_typed_pat';
    input.setAttribute('aria-label', 'Secret for github');
    const signInBtn = h.doc.createElement('button');
    signInBtn.textContent = 'Sign in';
    signInBtn.disabled = false; // already enabled due to pre-filled stale input

    let committedState = 'stale_typed_pat';
    let submittedSecret = null;
    input.addEventListener('input', () => {
      const nextVal = input.value;
      // Simulate React 18 createRoot committing state asynchronously in a microtask
      Promise.resolve().then(() => {
        committedState = nextVal;
      });
    });
    signInBtn.addEventListener('click', () => {
      submittedSecret = committedState;
    });
    yxb.appendChild(input);
    yxb.appendChild(signInBtn);
    gh.top.appendChild(yxb);
    list.appendChild(gh.card);
    sec.appendChild(list);
    h.body.appendChild(sec);

    h.sandbox.__agGitHubDeviceAuth.scan();
    gh.card.querySelector('[data-agy-github-auth="signin-btn"]').click();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.start[0].reqId, JSON.stringify({
      ok: true, device_code: 'dev-race', user_code: 'RACE-2222', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5
    }));
    await h.flushMicrotasks();
    h.advanceTime(5000);
    h.runPendingTimers();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[0].reqId, JSON.stringify({
      ok: true, status: 'complete', access_token: 'gho_fresh_device_token'
    }));
    await h.flushMicrotasks();
    // Before macrotask fires, button must NOT have been clicked synchronously with stale value
    assert.strictEqual(signInBtn.clicks, 0, 'must wait a macrotask before clicking already-enabled submit button');
    h.runPendingTimers();
    assert.strictEqual(signInBtn.clicks, 1, 'must click Sign in after async React commit');
    assert.strictEqual(submittedSecret, 'gho_fresh_device_token', 'must submit fresh access_token, not stale input');

    // 6. Regression: bottom-pinning when React appends Signed-in accounts list + Add account after container.
    const container = gh.card.querySelector('[data-agy-github-auth="container"]');
    const ul = h.doc.createElement('ul');
    ul.setAttribute('aria-label', 'Signed-in accounts');
    const nativeAdd = h.doc.createElement('button');
    nativeAdd.textContent = 'Add account';
    gh.card.appendChild(ul);
    gh.card.appendChild(nativeAdd);
    assert.notStrictEqual(gh.card.lastElementChild, container, 'precondition: React appended nodes after container');
    h.sandbox.__agGitHubDeviceAuth.scan();
    assert.strictEqual(gh.card.lastElementChild, container, 'container must be re-pinned to bottom of card');
  }

  // 7. Regression: ConnectRPC fallback sends Connect-Protocol-Version: 1 header when card is unmounted.
  {
    const h = createHarness({ pathname: '/customizations/plugins/github' });
    const sec = h.doc.createElement('section');
    sec.setAttribute('aria-label', 'Accounts');
    const list = h.doc.createElement('div');
    const gh = buildProviderCard(h.doc, {
      provider: 'github',
      typeLabel: 'API key',
      setupUrl: 'https://github.com/settings/tokens'
    });
    list.appendChild(gh.card);
    sec.appendChild(list);
    h.body.appendChild(sec);
    h.sandbox.__agGitHubDeviceAuth.scan();

    gh.card.querySelector('[data-agy-github-auth="signin-btn"]').click();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.start[0].reqId, JSON.stringify({
      ok: true, device_code: 'dev-rpc', user_code: 'RPCC-3333', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5
    }));
    await h.flushMicrotasks();
    // Simulate navigating away (card unmounted)
    h.body.innerHTML = '';
    h.advanceTime(5000);
    h.runPendingTimers();
    h.sandbox.__agGitHubDeviceAuthCallback(h.bridgeCalls.poll[0].reqId, JSON.stringify({
      ok: true, status: 'complete', access_token: 'gho_rpc_fallback_tok'
    }));
    await h.flushMicrotasks();
    assert.strictEqual(h.bridgeCalls.fetch.length, 1, 'must fall back to SignInPluginAuthProvider RPC');
    assert.strictEqual(
      h.bridgeCalls.fetch[0].url,
      '/exa.language_server_pb.LanguageServerService/SignInPluginAuthProvider'
    );
    assert.strictEqual(
      h.bridgeCalls.fetch[0].init.headers['Connect-Protocol-Version'],
      '1',
      'ConnectRPC fallback must send Connect-Protocol-Version: 1'
    );
    assert.strictEqual(
      JSON.parse(h.bridgeCalls.fetch[0].init.body).secret,
      'gho_rpc_fallback_tok'
    );
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF

    # Behavioral test: agent_notify.js exposes window.nativeNotifications, wraps document.hasFocus(),
    # suppresses alerts in foreground, dispatches rich background alerts with dedupe, and routes clicks.
    node - "$TMP/web/generated/patches/agent_notify.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

let inForeground = true;
const richCalls = [];
const settingsCalls = [];
const sandbox = {
  console,
  __AG_NATIVE_BRIDGE_TOKEN__: 'notify-tok',
  Android: {
    isInForeground: () => inForeground,
    notifyAgentEventRich: (tok, type, title, body, convId, notifId, silent) => {
      richCalls.push({ tok, type, title, body, convId, notifId, silent });
    },
    openNotificationSettings: (tok) => {
      settingsCalls.push(tok);
    }
  },
  document: {
    visibilityState: 'visible',
    hasFocus: () => true
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);

assert(sandbox.nativeNotifications, 'window.nativeNotifications must be defined');
assert.strictEqual(typeof sandbox.nativeNotifications.send, 'function');
assert.strictEqual(typeof sandbox.nativeNotifications.onClicked, 'function');
assert.strictEqual(typeof sandbox.nativeNotifications.openSystemPreferences, 'function');
assert.strictEqual(typeof sandbox.__agOpenNotificationConversation, 'function');

// 1. Foreground: document.hasFocus() is true and alerts are suppressed.
assert.strictEqual(sandbox.document.hasFocus(), true);
sandbox.nativeNotifications.send({
  id: 'agent-finished-1',
  title: 'Done',
  body: 'Finished task',
  payload: { cascadeId: 'conv-1' }
});
assert.strictEqual(richCalls.length, 0, 'foreground alerts must be suppressed');

// 2. Background: document.hasFocus() becomes false and alerts dispatch via notifyAgentEventRich.
inForeground = false;
assert.strictEqual(sandbox.document.hasFocus(), false, 'document.hasFocus() must reflect background state');
sandbox.nativeNotifications.send({
  id: 'agent-finished-2',
  title: 'Done',
  body: 'Finished background task',
  payload: { cascadeId: 'conv-2' }
});
assert.strictEqual(richCalls.length, 1, 'background alert must dispatch');
assert.strictEqual(richCalls[0].tok, 'notify-tok');
assert.strictEqual(richCalls[0].type, 'done');
assert.strictEqual(richCalls[0].convId, 'conv-2');
assert.strictEqual(richCalls[0].notifId, 'agent-finished-2');

// 3. Dedupe same notificationId.
sandbox.nativeNotifications.send({
  id: 'agent-finished-2',
  title: 'Done',
  body: 'Duplicate',
  payload: { cascadeId: 'conv-2' }
});
assert.strictEqual(richCalls.length, 1, 'duplicate notificationId must be deduped');

// 4. Cold-start click buffering + live click routing + openSystemPreferences.
sandbox.__agOpenNotificationConversation('conv-cold');
const clicked = [];
sandbox.nativeNotifications.onClicked((ev) => clicked.push(ev.cascadeId));
assert.deepStrictEqual(clicked, ['conv-cold'], 'buffered cold-start click must flush on subscribe');
sandbox.__agOpenNotificationConversation('conv-warm');
assert.deepStrictEqual(clicked, ['conv-cold', 'conv-warm'], 'warm click must route immediately');

sandbox.nativeNotifications.openSystemPreferences();
assert.deepStrictEqual(settingsCalls, ['notify-tok'], 'openSystemPreferences must forward token');

// 5. Per-conversation 15s cooldown for 'done' vs immediate 'action_required'/'approval'.
{
  let fakeNow = 100000;
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;

  const timers = new Map();
  let nextTimerId = 1;
  function fakeSetTimeout(fn, ms) {
    const id = nextTimerId++;
    timers.set(id, { fn, due: fakeNow + (ms || 0), interval: null });
    return id;
  }
  function fakeClearTimeout(id) {
    timers.delete(id);
  }
  function fakeSetInterval(fn, ms) {
    const id = nextTimerId++;
    timers.set(id, { fn, due: fakeNow + (ms || 0), interval: ms || 0 });
    return id;
  }
  function fakeClearInterval(id) {
    timers.delete(id);
  }
  function advanceTime(ms) {
    const target = fakeNow + ms;
    while (true) {
      let earliestId = null;
      let earliest = null;
      for (const [id, t] of timers.entries()) {
        if (t.due <= target && (!earliest || t.due < earliest.due)) {
          earliest = t;
          earliestId = id;
        }
      }
      if (!earliest) break;
      fakeNow = earliest.due;
      if (earliest.interval !== null) {
        earliest.due = fakeNow + earliest.interval;
      } else {
        timers.delete(earliestId);
      }
      earliest.fn();
    }
    fakeNow = target;
  }

  function makeDomEl(tag, attrs = {}, text = '') {
    const attrMap = new Map(Object.entries(attrs));
    const el = {
      tagName: String(tag).toUpperCase(),
      className: attrs.class || '',
      disabled: Boolean(attrs.disabled),
      parentNode: null,
      parentElement: null,
      children: [],
      _text: text,
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map((c) => c.textContent).join(' ');
      },
      set textContent(v) {
        this._text = String(v || '');
        this.children = [];
      },
      getAttribute(k) {
        return attrMap.has(k) ? String(attrMap.get(k)) : null;
      },
      setAttribute(k, v) {
        attrMap.set(k, String(v));
        if (k === 'class') this.className = String(v);
      },
      hasAttribute(k) {
        return attrMap.has(k);
      },
      appendChild(child) {
        child.parentNode = this;
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
          this.children.splice(idx, 1);
          child.parentNode = null;
          child.parentElement = null;
        }
        return child;
      },
      cloneNode(deep) {
        const copyAttrs = {};
        for (const [k, v] of attrMap.entries()) copyAttrs[k] = v;
        if (this.disabled) copyAttrs.disabled = true;
        const copy = makeDomEl(this.tagName, copyAttrs, this._text);
        if (deep) {
          for (const ch of this.children) copy.appendChild(ch.cloneNode(true));
        }
        return copy;
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchesSel(cur, sel)) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        function walk(node) {
          for (const ch of node.children) {
            if (parts.some((p) => matchesSel(ch, p))) out.push(ch);
            walk(ch);
          }
        }
        walk(this);
        return out;
      }
    };
    return el;
  }

  function matchesSimple(el, sel) {
    if (sel === 'button') return el.tagName === 'BUTTON';
    if (sel === 'h6') return el.tagName === 'H6';
    if (sel === 'svg') return el.tagName === 'SVG';
    if (sel === 'style') return el.tagName === 'STYLE';
    if (sel === 'script') return el.tagName === 'SCRIPT';
    if (sel === '.sr-only') return el.className.split(/\s+/).includes('sr-only');
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) return el.hasAttribute(inner);
      const k = inner.slice(0, eq).trim();
      const v = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      return el.getAttribute(k) === v;
    }
    return false;
  }

  function matchesSel(el, sel) {
    const tokens = sel.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) return matchesSimple(el, tokens[0]);
    if (!matchesSimple(el, tokens[tokens.length - 1])) return false;
    let cur = el.parentNode;
    let idx = tokens.length - 2;
    while (cur && idx >= 0) {
      if (matchesSimple(cur, tokens[idx])) idx--;
      cur = cur.parentNode;
    }
    return idx < 0;
  }

  const body = makeDomEl('body');
  const convView = makeDomEl('div', { 'data-testid': 'conversation-view', 'data-cascade-id': 'conv-bg-1' });
  const composer = makeDomEl('div', { 'data-agent-composer-root': '' });
  const stopBtn = makeDomEl('button', { 'data-testid': 'input-cancel-button', 'aria-label': 'Cancel (Ctrl+D)' });
  composer.appendChild(stopBtn);
  body.appendChild(convView);
  body.appendChild(composer);

  // Initial baseline reply before going to background
  const resp1 = makeDomEl('div', { 'data-testid': 'agent-response' });
  const h6_1 = makeDomEl('h6', { class: 'sr-only', 'data-find-ignore': 'true' }, 'Agent said');
  const bubble1 = makeDomEl('div', { 'data-bubble-side': 'agent' }, 'Initial baseline reply');
  resp1.appendChild(h6_1);
  resp1.appendChild(bubble1);
  convView.appendChild(resp1);

  const bgCalls = [];
  let bgFg = false;
  const bgDoc = {
    body,
    documentElement: body,
    visibilityState: 'hidden',
    hasFocus: () => false,
    addEventListener() {},
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s)
  };
  const bgSandbox = {
    console,
    Date: FakeDate,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    __AG_NATIVE_BRIDGE_TOKEN__: 'bg-tok',
    __AG_HOST_IN_FOREGROUND__: false,
    Android: {
      isInForeground: () => bgFg,
      notifyAgentEventRich: (tok, type, title, bodyText, convId, notifId, silent) => {
        bgCalls.push({ tok, type, title, body: bodyText, convId, notifId, silent });
      }
    },
    document: bgDoc,
    location: { pathname: '/c/conv-bg-1', search: '' },
    addEventListener() {}
  };
  bgSandbox.window = bgSandbox;
  bgSandbox.self = bgSandbox;
  bgSandbox.globalThis = bgSandbox;
  vm.runInNewContext(code, bgSandbox);

  // Agent starts working on a new turn: Stop button is present + live-status-row says "Working" + intermediate text appears.
  const resp2 = makeDomEl('div', { 'data-testid': 'agent-response' });
  const h6_2 = makeDomEl('h6', { class: 'sr-only', 'data-find-ignore': 'true' }, 'Agent working');
  const bubble2 = makeDomEl('div', { 'data-bubble-side': 'agent' }, 'Working on step 1...');
  const toolStep = makeDomEl('div', { 'data-testid': 'mcp-tool-step' }, 'Running tool foo');
  const liveRow = makeDomEl('div', { 'data-testid': 'live-status-row' }, 'Working');
  bubble2.appendChild(toolStep);
  resp2.appendChild(h6_2);
  resp2.appendChild(bubble2);
  resp2.appendChild(liveRow);
  convView.appendChild(resp2);

  // Even after 4000ms (> 3000ms), NO notification must fire while Stop button / working status is present!
  advanceTime(4000);
  assert.strictEqual(bgCalls.length, 0, 'must NOT notify while Stop button / active working indicator is present');

  // Remove Stop button, keep live-status-row saying "Thinking..." -> still actively working, must NOT notify!
  composer.removeChild(stopBtn);
  h6_2.textContent = 'Agent said';
  liveRow.textContent = 'Thinking';
  advanceTime(4000);
  assert.strictEqual(bgCalls.length, 0, 'must NOT notify while live-status-row says Thinking');

  // Agent finishes its own turn and parks in Swarm ("Waiting for subagent") with final reply text!
  liveRow.textContent = 'Waiting for subagent';
  bubble2._text = 'All done with your build! Ready to test.';
  // Wait 2000ms (< 2500ms settle): must NOT have fired yet.
  advanceTime(2000);
  assert.strictEqual(bgCalls.length, 0, 'must wait for >= 2500ms settle after working stops');

  // Advance another 2500ms -> fires ONCE with clean reply text (excluding tool step)!
  advanceTime(2500);
  assert.strictEqual(bgCalls.length, 1, 'must fire ONCE after working stops and reply settles');
  assert.strictEqual(bgCalls[0].type, 'done');
  assert.strictEqual(bgCalls[0].convId, 'conv-bg-1');
  assert.strictEqual(bgCalls[0].body, 'All done with your build! Ready to test.');

  // Minor DOM re-render (e.g. adding a subagent status card) with same reply text must NEVER re-fire even after 20s!
  const subCard = makeDomEl('div', { 'data-testid': 'subagent-node' }, 'worker-1 status updated');
  resp2.appendChild(subCard);
  advanceTime(20000);
  assert.strictEqual(bgCalls.length, 1, 'same reply or subagent card DOM re-render must NEVER re-fire');

  // Cooldown check: upstream 'done' within 15s of previous 'done' is suppressed, while 'approval' fires immediately.
  bgSandbox.nativeNotifications.send({
    id: 'agent-finished-conv-bg-1-99',
    title: 'Done',
    body: 'First upstream done',
    payload: { cascadeId: 'conv-bg-1' }
  });
  assert.strictEqual(bgCalls.length, 2, 'upstream done after 20s cooldown should fire');
  advanceTime(5000);
  bgSandbox.nativeNotifications.send({
    id: 'agent-finished-conv-bg-1-100',
    title: 'Done',
    body: 'Second upstream done within 15s',
    payload: { cascadeId: 'conv-bg-1' }
  });
  assert.strictEqual(bgCalls.length, 2, 'second done within 15s per-conversation cooldown must be suppressed');
  bgSandbox.nativeNotifications.send({
    id: 'perm-101',
    title: 'Permission',
    body: 'Approve command?',
    payload: { cascadeId: 'conv-bg-1', type: 'approval' }
  });
  assert.strictEqual(bgCalls.length, 3, 'approval notification must bypass 15s done cooldown');
}
EOF

    # Behavioral test: swarm_pane_chip injects a compact Swarm chip into
    # [data-agent-composer-root], opens/toggles the Swarm sidecar pane via
    # Redux/extensibility (even without a rendered sidecar:// link) or DOM
    # fallback, debounces rapid double-clicks, and never mutates composer text.
    node - "$TMP/web/generated/patches/swarm_pane_chip.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

function makeEl(tag, attrs = {}) {
  const attrMap = new Map(Object.entries(attrs));
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    id: attrs.id || '',
    className: attrs.class || '',
    type: '',
    innerHTML: '',
    textContent: attrs.textContent || '',
    disabled: false,
    parentElement: null,
    children: [],
    setAttribute(k, v) {
      attrMap.set(k, String(v));
      if (k === 'id') this.id = String(v);
    },
    getAttribute(k) {
      return attrMap.has(k) ? attrMap.get(k) : null;
    },
    hasAttribute(k) {
      return attrMap.has(k);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentElement = this;
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    click() {
      const fns = listeners.get('click') || [];
      for (const fn of fns) fn({ preventDefault() {}, stopPropagation() {} });
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === '[data-side-panel-focus-scope="true"]' && cur.getAttribute('data-side-panel-focus-scope') === 'true') {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      function walk(node) {
        for (const ch of node.children) {
          if (matches(ch, sel)) out.push(ch);
          walk(ch);
        }
      }
      walk(this);
      return out;
    }
  };
  return el;
}

function matches(el, sel) {
  if (sel === '[data-agent-composer-root]') return el.hasAttribute('data-agent-composer-root');
  if (sel === '[data-agy-swarm-chip="true"]') return el.getAttribute('data-agy-swarm-chip') === 'true';
  if (sel === '[data-testid="sidecar-iframe-slot"][data-visible="true"]') {
    return el.getAttribute('data-testid') === 'sidecar-iframe-slot' && el.getAttribute('data-visible') === 'true';
  }
  if (sel === '[data-testid="sidecar-iframe-slot"][data-sidecar-id*="swarm" i]') {
    return el.getAttribute('data-testid') === 'sidecar-iframe-slot' && /swarm/i.test(el.getAttribute('data-sidecar-id') || '');
  }
  if (sel === 'a[href]') return el.tagName === 'A' && el.hasAttribute('href');
  if (sel === 'button[data-quotable-inline="true"]') {
    return el.tagName === 'BUTTON' && el.getAttribute('data-quotable-inline') === 'true';
  }
  if (sel === '[data-testid="plugins-submenu-item"][data-sidecar-id]') {
    return el.getAttribute('data-testid') === 'plugins-submenu-item' && el.hasAttribute('data-sidecar-id');
  }
  if (sel === '[data-testid="mobile-toggle-aux-sidebar"]') {
    return el.getAttribute('data-testid') === 'mobile-toggle-aux-sidebar';
  }
  if (sel === '[data-testid="toggle-aux-sidebar"]') {
    return el.getAttribute('data-testid') === 'toggle-aux-sidebar';
  }
  if (sel === 'button[aria-label="Toggle Side Panel"]') {
    return el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Toggle Side Panel';
  }
  return false;
}

// Build mock DOM: main composer + chat input + nested side-panel composer (must be skipped).
const head = makeEl('head');
const body = makeEl('body');
const root = makeEl('div', { id: 'root' });
body.appendChild(root);

const chatInput = makeEl('div', { contenteditable: 'true', textContent: 'Keep my draft message intact' });
const composerRoot = makeEl('div', { 'data-agent-composer-root': '' });
const leftGroup = makeEl('div', { class: 'flex min-w-0 flex-1' });
const rightGroup = makeEl('div', { class: 'shrink-0 flex' });
composerRoot.appendChild(leftGroup);
composerRoot.appendChild(rightGroup);
root.appendChild(chatInput);
root.appendChild(composerRoot);

const sidePanelScope = makeEl('div', { 'data-side-panel-focus-scope': 'true' });
const nestedComposer = makeEl('div', { 'data-agent-composer-root': '' });
sidePanelScope.appendChild(nestedComposer);
root.appendChild(sidePanelScope);

// Mock Redux store + extensibility registry on React fibers above composerRoot.
const dispatched = [];
const reduxState = {
  sidePanel: { conversationPanes: {} },
  sidePanelV2: { conversationPanes: {} }
};
const store = {
  getState: () => reduxState,
  dispatch(action) {
    dispatched.push(action);
    const scope = action.payload && action.payload.panelScope;
    const cid = scope && scope.cascadeId;
    if (action.type === 'sidePanelV2/setContent' && cid) {
      reduxState.sidePanelV2.conversationPanes[cid] = {
        activeTabId: action.payload.tabId,
        tabs: [{ id: action.payload.tabId, content: action.payload.content }]
      };
    } else if (action.type === 'sidePanel/setSidePanelOpen' && cid) {
      reduxState.sidePanel.conversationPanes[cid] = {
        ...(reduxState.sidePanel.conversationPanes[cid] || {}),
        isPaneOpen: Boolean(action.payload.isOpen)
      };
    }
  }
};
const registry = {
  get(key) {
    if (key === 'auxPaneComponent') return { redesignEnabled: true };
    if (key === 'extensibility') {
      return {
        provider: {
          getState: () => [{
            sidecarId: 'builtin/swarm',
            baseUrl: 'https://127.0.0.1:45158/sidecar/swarm',
            config: {
              uiConfig: {
                displayName: 'Swarm',
                views: [{ path: '/swarm_board', title: 'Swarm Board', entrypoint: 1 }]
              }
            }
          }]
        },
        resolveSidecarUrl: (base, p) => base + p
      };
    }
    return undefined;
  }
};
const iframeSrcCalls = [];
const iframeCtx = {
  setIframeSrc: (base, full) => iframeSrcCalls.push({ base, full }),
  navigateIframe: () => {}
};

const fiberStore = { memoizedProps: { value: { store } }, return: null };
const fiberReg = { memoizedProps: { value: registry }, return: fiberStore };
const fiberIframe = { memoizedProps: { value: iframeCtx }, return: fiberReg };
composerRoot.__reactFiber$test = { memoizedProps: {}, return: fiberIframe };

let fakeNow = 50000;
const RealDate = Date;
function FakeDate(...args) {
  return args.length ? new RealDate(...args) : new RealDate(fakeNow);
}
FakeDate.now = () => fakeNow;

const mockDocument = {
  readyState: 'complete',
  head,
  body,
  documentElement: body,
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => (id === 'root' ? root : head.children.find((c) => c.id === id) || null),
  querySelector: (sel) => body.querySelector(sel),
  querySelectorAll: (sel) => body.querySelectorAll(sel)
};

const sandbox = {
  console,
  Date: FakeDate,
  URL,
  URLSearchParams,
  setTimeout: (fn) => { fn(); return 1; },
  document: mockDocument,
  location: { pathname: '/c/conv-swarm-1', search: '' }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.runInNewContext(code, sandbox);

// 1. Chip injected into main composer (between leftGroup and rightGroup), NOT into side-panel sub-composer.
assert.strictEqual(composerRoot.children.length, 3, 'chip must be inserted into main composer');
const chip = composerRoot.children[1];
assert.strictEqual(chip.getAttribute('data-agy-swarm-chip'), 'true');
assert.strictEqual(chip.getAttribute('data-testid'), 'agy-swarm-pane-chip');
assert.strictEqual(nestedComposer.children.length, 0, 'side-panel sub-composer must be skipped');

// Re-scanning must not duplicate the chip.
assert.strictEqual(sandbox.__agSwarmPaneChip.scan(), 0, 'scan must be idempotent');

// 2. Click when NO sidecar:// link is in DOM -> dispatches sidePanelV2/setContent + sidePanel/setSidePanelOpen(true).
chip.click();
assert.strictEqual(dispatched.length, 2, 'opening Swarm pane must dispatch setContent + setSidePanelOpen');
assert.strictEqual(dispatched[0].type, 'sidePanelV2/setContent');
assert.strictEqual(dispatched[0].payload.panelScope.kind, 'cascadeId');
assert.strictEqual(dispatched[0].payload.panelScope.cascadeId, 'conv-swarm-1');
assert.strictEqual(dispatched[0].payload.tabId, 'sidecar__builtin/swarm__/swarm_board');
assert.strictEqual(dispatched[0].payload.content.type, 'sidecarView');
assert.strictEqual(dispatched[1].type, 'sidePanel/setSidePanelOpen');
assert.strictEqual(dispatched[1].payload.isOpen, true);
assert.strictEqual(iframeSrcCalls.length, 1, 'iframeCtx.setIframeSrc should be called');
assert.strictEqual(chip.getAttribute('data-swarm-open'), 'true');

// 3. Rapid double-click within 250ms is debounced.
fakeNow += 100;
chip.click();
assert.strictEqual(dispatched.length, 2, 'double-tap within 250ms must be debounced');

// 4. Click again after 250ms while Swarm pane is open -> toggles CLOSED.
fakeNow += 300;
chip.click();
assert.strictEqual(dispatched.length, 3, 'second click after debounce must close pane');
assert.strictEqual(dispatched[2].type, 'sidePanel/setSidePanelOpen');
assert.strictEqual(dispatched[2].payload.isOpen, false);
assert.strictEqual(chip.getAttribute('data-swarm-open'), 'false');

// 5. Fallback to DOM inline Swarm pill when React fiber context is unavailable.
delete composerRoot.__reactFiber$test;
const inlinePill = makeEl('button', { 'data-quotable-inline': 'true', title: 'Swarm Board', textContent: 'Open the Swarm UI' });
let pillClicks = 0;
inlinePill.addEventListener('click', () => { pillClicks++; });
root.appendChild(inlinePill);
fakeNow += 300;
chip.click();
assert.strictEqual(pillClicks, 1, 'DOM fallback must click existing Open the Swarm UI pill');

// 6. Composer chat input text is completely untouched.
assert.strictEqual(chatInput.textContent, 'Keep my draft message intact', 'chat input must never be mutated');
EOF

    # Behavioral test: patches/project_delete_folder.js injects an optional
    # unchecked-by-default checkbox on local project delete dialogs, skips
    # remote/protected projects, and calls Android.deleteProjectFolder(token, path)
    # only when checked on confirm.
    node - "$TMP/web/generated/patches/project_delete_folder.js" <<'EOF'
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(process.argv[2], 'utf8');

function makeEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    className: attrs.className || '',
    type: attrs.type || '',
    checked: Boolean(attrs.checked),
    attrs: Object.assign({}, attrs),
    children: [],
    parentElement: null,
    ownerDocument: null,
    _text: attrs.textContent || '',
    listeners: new Map(),
    setAttribute(k, v) {
      const sv = String(v);
      this.attrs[k] = sv;
      if (k === 'id') this.id = sv;
      if (k === 'class') this.className = sv;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    appendChild(child) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    },
    addEventListener(type, fn, capture) {
      const key = `${type}:${capture ? 'cap' : 'bub'}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(fn);
    },
    dispatchEvent(ev) {
      const e = Object.assign({ target: this }, ev);
      for (const fn of (this.listeners.get(`${e.type}:cap`) || [])) fn(e);
      for (const fn of (this.listeners.get(`${e.type}:bub`) || [])) fn(e);
      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click' });
    },
    matches(sel) {
      return sel.split(',').some((raw) => {
        const s = raw.trim();
        if (s === 'button' || s === 'p' || s === 'strong' || s === 'h1' || s === 'h2' || s === 'h3' || s === 'input' || s === 'label') {
          return this.tagName === s.toUpperCase();
        }
        if (s === '.agy-dialog') return this.className.split(/\s+/).includes('agy-dialog');
        const attrEq = s.match(/^\[([^=\]]+)="([^"]+)"\]$/);
        if (attrEq) return this.getAttribute(attrEq[1]) === attrEq[2];
        const attrOnly = s.match(/^\[([^\]]+)\]$/);
        if (attrOnly) return this.getAttribute(attrOnly[1]) !== null;
        return false;
      });
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    },
    set(v) {
      this._text = String(v);
      this.children = [];
    }
  });
  return el;
}

const head = makeEl('head');
const body = makeEl('body');
const root = makeEl('div', { id: 'root' });
body.appendChild(root);

const mockDocument = {
  readyState: 'complete',
  head,
  body,
  documentElement: body,
  createElement(tag) {
    const el = makeEl(tag);
    el.ownerDocument = mockDocument;
    return el;
  },
  getElementById: (id) => (id === 'root' ? root : head.children.find((c) => c.id === id) || null),
  querySelector: (sel) => body.querySelector(sel),
  querySelectorAll: (sel) => body.querySelectorAll(sel)
};
head.ownerDocument = mockDocument;
body.ownerDocument = mockDocument;
root.ownerDocument = mockDocument;

const deleteCalls = [];
const sandbox = {
  console,
  document: mockDocument,
  __AG_NATIVE_BRIDGE_TOKEN__: 'tok-secret-123',
  Android: {
    deleteProjectFolder(token, path) {
      deleteCalls.push({ token, path });
      return JSON.stringify({ ok: true, path, error: '' });
    }
  },
  setTimeout: (fn) => { fn(); return 1; }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const projectsState = [
  { id: 'proj-local', name: 'MyApp', folderUris: ['file:///storage/emulated/0/Documents/MyApp'] },
  { id: 'proj-remote', name: 'RemoteRepo', backendType: 2, folderUris: [] },
  { id: 'proj-github', name: 'GitHubRepo', folderUris: ['https://github.com/org/repo'] },
  { id: 'proj-protected', name: 'DocsRoot', folderUris: ['file:///storage/emulated/0/Documents'] }
];
const store = {
  getState: () => ({
    sidebarProjects: { enabled: true, projects: projectsState }
  })
};
const fiberStore = { memoizedProps: { value: { store } }, return: null };

function makeDeleteDialog(projectId, projectName, headingText = 'Delete Project') {
  const dialog = makeEl('div', { role: 'dialog', className: 'agy-dialog' });
  dialog.ownerDocument = mockDocument;
  const header = makeEl('h2', { textContent: headingText });
  const content = makeEl('div');
  const p = makeEl('p', { textContent: 'Are you sure you want to delete the project ' });
  const strong = makeEl('strong', { textContent: projectName });
  p.appendChild(strong);
  const footer = makeEl('div', { className: 'flex justify-end gap-3' });
  const cancelBtn = makeEl('button', { textContent: 'Cancel' });
  const deleteBtn = makeEl('button', { 'data-autofocus': 'true', textContent: 'Delete' });
  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);
  content.appendChild(p);
  content.appendChild(footer);
  dialog.appendChild(header);
  dialog.appendChild(content);

  const fiberParent = { memoizedProps: { projectId, projectName }, return: fiberStore };
  dialog.__reactFiber$test = { memoizedProps: {}, return: fiberParent };
  body.appendChild(dialog);
  return { dialog, cancelBtn, deleteBtn };
}

vm.runInNewContext(code, sandbox);

// 1. Local project delete dialog gets checkbox (unchecked by default) + compact path.
const d1 = makeDeleteDialog('proj-local', 'MyApp');
assert.strictEqual(sandbox.__agProjectDeleteFolder.scan(), 1, 'checkbox must be injected for local project');
assert.strictEqual(sandbox.__agProjectDeleteFolder.scan(), 0, 'scan must be idempotent');
const cb1 = d1.dialog.querySelector('[data-agy-delete-folder-checkbox="true"]');
const row1 = d1.dialog.querySelector('[data-agy-delete-folder-row="true"]');
assert.ok(cb1, 'checkbox element must exist');
assert.strictEqual(cb1.checked, false, 'checkbox must be unchecked by default');
assert.strictEqual(row1.getAttribute('data-checked'), 'false');

// 2. Confirm while unchecked -> NO native deleteProjectFolder call.
d1.deleteBtn.click();
assert.strictEqual(deleteCalls.length, 0, 'confirm with unchecked checkbox must not call native deleter');

// 3. Remote / cloud / GitHub / protected-root projects -> NO checkbox injected.
const dRemote = makeDeleteDialog('proj-remote', 'RemoteRepo');
const dGithub = makeDeleteDialog('proj-github', 'GitHubRepo');
const dProtected = makeDeleteDialog('proj-protected', 'DocsRoot');
assert.strictEqual(sandbox.__agProjectDeleteFolder.scan(), 0, 'must not inject checkbox for remote or protected-root projects');
assert.strictEqual(dRemote.dialog.querySelector('[data-agy-delete-folder-checkbox="true"]'), null);
assert.strictEqual(dGithub.dialog.querySelector('[data-agy-delete-folder-checkbox="true"]'), null);
assert.strictEqual(dProtected.dialog.querySelector('[data-agy-delete-folder-checkbox="true"]'), null);

// 4. Confirm while checked -> calls Android.deleteProjectFolder(token, path) once.
const d2 = makeDeleteDialog('proj-local', 'MyApp', 'Delete Workspace');
assert.strictEqual(sandbox.__agProjectDeleteFolder.scan(), 1);
const cb2 = d2.dialog.querySelector('[data-agy-delete-folder-checkbox="true"]');
const row2 = d2.dialog.querySelector('[data-agy-delete-folder-row="true"]');
cb2.checked = true;
cb2.dispatchEvent({ type: 'change' });
assert.strictEqual(row2.getAttribute('data-checked'), 'true', 'row must reflect checked danger state');
d2.deleteBtn.click();
assert.strictEqual(deleteCalls.length, 1, 'confirm with checked checkbox must call native deleter');
assert.strictEqual(deleteCalls[0].token, 'tok-secret-123');
assert.strictEqual(deleteCalls[0].path, '/storage/emulated/0/Documents/MyApp');

// Second click on same dialog is deduplicated.
d2.deleteBtn.click();
assert.strictEqual(deleteCalls.length, 1, 'duplicate confirm click must not trigger second native delete');
EOF
fi

echo "web build selftest: OK"
