/**
 * patches/project_delete_folder/install.js - Injects an optional, unchecked-by-default
 * "Also delete project folder from storage" checkbox into the Delete Project /
 * Remove Workspace confirmation dialog for local projects, delegating safe deletion
 * to AndroidBridge.deleteProjectFolder(token, path).
 */
var global = typeof window !== 'undefined' ? window : this;

if (!global.__AG_PROJECT_DELETE_FOLDER_INSTALLED__) {
  global.__AG_PROJECT_DELETE_FOLDER_INSTALLED__ = true;

  var STYLE_ID = 'agy-project-delete-folder-style';
  var DIALOG_ATTR = 'data-agy-delete-folder-injected';
  var ROW_ATTR = 'data-agy-delete-folder-row';
  var CHECKBOX_ATTR = 'data-agy-delete-folder-checkbox';
  var scanScheduled = false;

  var FORBIDDEN_FILES_SUBTREES = {
    '.gemini': true, '.config': true, '.local': true, '.cache': true,
    '.tmp': true, '.ssh': true, '.npm': true, '.android': true,
    usr: true, runtime: true, web: true, logs: true, etc: true,
    cache: true, home: true, tmp: true, bin: true, lib: true,
    share: true, var: true, opt: true
  };

  var PROTECTED_FILES_CONTAINERS = {
    projects: true
  };

  var PROTECTED_EXTERNAL_TOP_LEVEL = {
    documents: true, download: true, downloads: true, dcim: true,
    pictures: true, music: true, movies: true, android: true,
    alarms: true, notifications: true, ringtones: true, podcasts: true,
    audiobooks: true, recordings: true, 'lost.dir': true
  };

  function ensureStyles(doc) {
    if (!doc || !doc.createElement) return;
    if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
    var parent = doc.head || doc.documentElement;
    if (!parent || typeof parent.appendChild !== 'function') return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.agy-del-folder-row{' +
        'display:flex;align-items:flex-start;gap:10px;margin:0 0 16px 0;padding:10px 12px;' +
        'border-radius:8px;border:1px solid var(--border,rgba(148,163,184,0.28));' +
        'background:var(--muted,rgba(148,163,184,0.1));cursor:pointer;' +
        'user-select:none;-webkit-user-select:none;' +
        'transition:border-color 150ms ease,background-color 150ms ease;' +
      '}' +
      '.agy-del-folder-row[data-checked="true"]{' +
        'border-color:rgba(239,68,68,0.55);' +
        'background:rgba(239,68,68,0.1);' +
      '}' +
      '.agy-del-folder-cb{' +
        'margin:2px 0 0 0;width:15px;height:15px;flex-shrink:0;cursor:pointer;' +
        'accent-color:#ef4444;' +
      '}' +
      '.agy-del-folder-text{' +
        'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;' +
      '}' +
      '.agy-del-folder-label{' +
        'font-size:13px;font-weight:500;line-height:1.35;color:var(--foreground,inherit);' +
      '}' +
      '.agy-del-folder-row[data-checked="true"] .agy-del-folder-label{' +
        'color:#ef4444;' +
      '}' +
      '.agy-del-folder-path{' +
        'font-size:11.5px;line-height:1.3;color:var(--muted-foreground,#94a3b8);' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      '}';
    parent.appendChild(style);
  }

  function getBridgeEnv() {
    var bridge = global.Android || global.AndroidBridge || null;
    var token = global.__AG_NATIVE_BRIDGE_TOKEN__;
    if (!bridge || !token || typeof bridge.deleteProjectFolder !== 'function') {
      return null;
    }
    return { bridge: bridge, token: String(token) };
  }

  function decodePercentSafe(str) {
    if (str.indexOf('%') < 0) return str;
    try {
      return decodeURIComponent(str);
    } catch (e) {
      return null;
    }
  }

  function isAllowedLocalProjectPath(posixPath) {
    if (typeof posixPath !== 'string' || !posixPath || posixPath.charAt(0) !== '/') {
      return false;
    }
    if (posixPath.indexOf('\0') >= 0) return false;
    // Reject path traversal segments
    var rawSegs = posixPath.split('/');
    for (var i = 0; i < rawSegs.length; i++) {
      if (rawSegs[i] === '..' || rawSegs[i] === '.') return false;
    }

    // Check Android external storage: /storage/emulated/0/... or /sdcard/...
    var extPrefixes = ['/storage/emulated/0/', '/sdcard/'];
    for (var e = 0; e < extPrefixes.length; e++) {
      var ep = extPrefixes[e];
      if (posixPath.indexOf(ep) === 0) {
        var relExt = posixPath.slice(ep.length);
        if (!relExt) return false;
        var extSegs = relExt.split('/').filter(Boolean);
        if (extSegs.length === 0) return false;
        var extFirst = extSegs[0];
        var extFirstLower = extFirst.toLowerCase();
        if (extFirst.charAt(0) === '.' || extFirstLower === 'android') return false;
        if (extSegs.length === 1 && PROTECTED_EXTERNAL_TOP_LEVEL[extFirstLower]) return false;
        return true;
      }
    }

    // Check app filesDir: /data/user/<u|0>/com.agy/files/... or /data/data/com.agy/files/...
    var filesMatch = posixPath.match(/^\/data\/(?:user\/\d+|data)\/[^/]+\/files\/(.+)$/);
    if (filesMatch && filesMatch[1]) {
      var filesSegs = filesMatch[1].split('/').filter(Boolean);
      if (filesSegs.length === 0) return false;
      var fFirst = filesSegs[0];
      var fFirstLower = fFirst.toLowerCase();
      if (fFirst.charAt(0) === '.' || FORBIDDEN_FILES_SUBTREES[fFirstLower]) return false;
      if (PROTECTED_FILES_CONTAINERS[fFirstLower] && filesSegs.length < 2) return false;
      return true;
    }

    return false;
  }

  function normalizeLocalPath(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s || s.indexOf('\0') >= 0) return null;

    var schemeIdx = s.indexOf('://');
    if (schemeIdx >= 0) {
      var scheme = s.slice(0, schemeIdx).toLowerCase();
      if (scheme !== 'file') return null;
      s = s.slice(schemeIdx + 3);
      if (/^localhost\//i.test(s)) {
        s = s.slice(9);
      }
      if (s.charAt(0) !== '/') return null;
      var qIdx = s.indexOf('?');
      if (qIdx >= 0) s = s.slice(0, qIdx);
      var hIdx = s.indexOf('#');
      if (hIdx >= 0) s = s.slice(0, hIdx);
      s = decodePercentSafe(s);
      if (!s) return null;
    }

    if (s.charAt(0) !== '/') return null;
    while (s.length > 1 && s.charAt(s.length - 1) === '/') {
      s = s.slice(0, -1);
    }
    return isAllowedLocalProjectPath(s) ? s : null;
  }

  function formatCompactPath(path) {
    if (!path || path.length <= 44) return path;
    var parts = path.split('/').filter(Boolean);
    if (parts.length <= 2) {
      return '\u2026' + path.slice(path.length - 40);
    }
    var tail = parts.slice(-2).join('/');
    if (tail.length <= 40) {
      return '\u2026/' + tail;
    }
    return '\u2026' + path.slice(path.length - 40);
  }

  function getFiberFromDom(el) {
    var cur = el;
    var depth = 0;
    while (cur && typeof cur === 'object' && depth < 25) {
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

  function extractLocalPathFromProjectObj(project) {
    if (!project || typeof project !== 'object') return null;
    // backendType === 2 is cloud/remote project in upstream main.js
    if (project.backendType === 2 || project.isRemote === true) return null;

    var candidates = [];
    var resources = project.projectResources && project.projectResources.resources;
    if (Array.isArray(resources)) {
      for (var i = 0; i < resources.length; i++) {
        var res = resources[i];
        var t = res && res.type;
        if (!t) continue;
        if (t.case === 'folderUri' && typeof t.value === 'string') {
          candidates.push(t.value);
        } else if (t.case === 'gitFolder' && t.value && typeof t.value.folderUri === 'string') {
          candidates.push(t.value.folderUri);
        }
      }
    }
    if (Array.isArray(project.folderUris)) {
      for (var j = 0; j < project.folderUris.length; j++) {
        candidates.push(project.folderUris[j]);
      }
    }
    if (Array.isArray(project.workspaceUris)) {
      for (var w = 0; w < project.workspaceUris.length; w++) {
        candidates.push(project.workspaceUris[w]);
      }
    }
    if (typeof project.folderUri === 'string') candidates.push(project.folderUri);
    if (typeof project.localPath === 'string') candidates.push(project.localPath);

    for (var c = 0; c < candidates.length; c++) {
      var norm = normalizeLocalPath(candidates[c]);
      if (norm) return norm;
    }
    return null;
  }

  function inspectFiberContext(dialogEl) {
    var info = {
      projectId: null,
      projectName: null,
      directProject: null,
      store: null,
      projectMgmt: null
    };

    function walkFiber(startFiber) {
      var cur = startFiber;
      var steps = 0;
      while (cur && steps < 250) {
        steps++;
        var props = cur.memoizedProps;
        if (props && typeof props === 'object') {
          if (!info.projectId && typeof props.projectId === 'string' && props.projectId) {
            info.projectId = props.projectId;
          }
          if (!info.projectId && typeof props.targetProjectId === 'string' && props.targetProjectId) {
            info.projectId = props.targetProjectId;
          }
          if (!info.projectName && typeof props.projectName === 'string' && props.projectName) {
            info.projectName = props.projectName;
          }
          if (!info.directProject && props.project && typeof props.project === 'object') {
            info.directProject = props.project;
          }
          var val = props.value;
          if (val && typeof val === 'object') {
            if (!info.store && val.store && typeof val.store.getState === 'function') {
              info.store = val.store;
            }
            if (!info.projectMgmt &&
                (val.projectsStateProvider || typeof val.getProjectStateProvider === 'function')) {
              info.projectMgmt = val;
            }
          }
        }
        cur = cur.return || null;
      }
    }

    var dialogFiber = getFiberFromDom(dialogEl);
    if (dialogFiber) walkFiber(dialogFiber);

    if ((!info.store || !info.projectMgmt) && typeof document !== 'undefined' && document.getElementById) {
      var rootEl = document.getElementById('root');
      var rootFiber = getFiberFromDom(rootEl);
      if (rootFiber) {
        // Walk down a few levels from root container to find Redux/Project providers
        var queue = [rootFiber];
        var visited = 0;
        while (queue.length > 0 && visited < 120 && (!info.store || !info.projectMgmt)) {
          var f = queue.shift();
          visited++;
          if (!f) continue;
          var val = f.memoizedProps && f.memoizedProps.value;
          if (val && typeof val === 'object') {
            if (!info.store && val.store && typeof val.store.getState === 'function') {
              info.store = val.store;
            }
            if (!info.projectMgmt &&
                (val.projectsStateProvider || typeof val.getProjectStateProvider === 'function')) {
              info.projectMgmt = val;
            }
          }
          if (f.child) queue.push(f.child);
          if (f.sibling) queue.push(f.sibling);
        }
      }
    }

    return info;
  }

  function extractProjectNameFromDom(dialogEl) {
    if (!dialogEl || typeof dialogEl.querySelectorAll !== 'function') return null;
    var paragraphs = dialogEl.querySelectorAll('p');
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i];
      var text = (p.textContent || '').trim();
      if (/Are you sure you want to (?:delete|remove) the (?:project|workspace)\b/i.test(text)) {
        var strong = p.querySelector ? p.querySelector('strong') : null;
        if (strong && strong.textContent && strong.textContent.trim()) {
          return strong.textContent.trim();
        }
      }
    }
    var anyStrong = dialogEl.querySelector ? dialogEl.querySelector('strong') : null;
    return anyStrong && anyStrong.textContent ? anyStrong.textContent.trim() : null;
  }

  function resolveLocalFolderPath(dialogEl) {
    if (!dialogEl) return null;

    // 0. Explicit data attribute on dialog (if provided)
    if (typeof dialogEl.getAttribute === 'function') {
      var attrPath = dialogEl.getAttribute('data-project-path') ||
        dialogEl.getAttribute('data-folder-uri') ||
        dialogEl.getAttribute('data-workspace-uri');
      if (attrPath) {
        return normalizeLocalPath(attrPath);
      }
    }

    var info = inspectFiberContext(dialogEl);
    var projectName = info.projectName || extractProjectNameFromDom(dialogEl);
    var projectId = info.projectId;

    // 1. Direct project object on fiber
    if (info.directProject) {
      var direct = extractLocalPathFromProjectObj(info.directProject);
      if (direct) return direct;
      if (info.directProject.backendType === 2 || info.directProject.isRemote === true) {
        return null;
      }
    }

    // 2. ProjectManagementService (authoritative: includes backendType & projectResources)
    if (info.projectMgmt) {
      try {
        var entry = null;
        if (projectId && typeof info.projectMgmt.getProjectStateProvider === 'function') {
          var prov = info.projectMgmt.getProjectStateProvider(projectId);
          entry = prov && typeof prov.getState === 'function' ? prov.getState() : null;
        }
        if (!entry && info.projectMgmt.projectsStateProvider &&
            typeof info.projectMgmt.projectsStateProvider.getState === 'function') {
          var allEntries = info.projectMgmt.projectsStateProvider.getState() || [];
          for (var i = 0; i < allEntries.length; i++) {
            var item = allEntries[i];
            var p = item && item.project;
            if (!p) continue;
            if (projectId && p.id === projectId) {
              entry = item;
              break;
            }
            if (!projectId && projectName && p.name === projectName) {
              entry = item;
              break;
            }
          }
        }
        if (entry && entry.project) {
          return extractLocalPathFromProjectObj(entry.project);
        }
      } catch (ignored) {}
    }

    // 3. Redux store (sidebarProjects.projects + settingsScreen fallback for active projectId)
    if (info.store && typeof info.store.getState === 'function') {
      try {
        var state = info.store.getState() || {};
        if (!projectId && state.settingsScreen && typeof state.settingsScreen === 'object') {
          projectId = state.settingsScreen.targetProjectId ||
            state.settingsScreen.projectId ||
            state.settingsScreen.selectedProjectId || null;
        }
        var sp = state.sidebarProjects;
        var list = sp && Array.isArray(sp.projects) ? sp.projects : [];
        var matched = null;
        if (projectId) {
          for (var j = 0; j < list.length; j++) {
            if (list[j] && list[j].id === projectId) {
              matched = list[j];
              break;
            }
          }
        }
        if (!matched && projectName) {
          var nameMatches = [];
          for (var k = 0; k < list.length; k++) {
            if (list[k] && list[k].name === projectName) {
              nameMatches.push(list[k]);
            }
          }
          if (nameMatches.length === 1) {
            matched = nameMatches[0];
          } else if (nameMatches.length > 1) {
            // Avoid ambiguity if multiple projects share the same name
            matched = null;
          }
        }
        if (matched) {
          return extractLocalPathFromProjectObj(matched);
        }
      } catch (ignored) {}
    }

    return null;
  }

  function isProjectDeleteDialog(dialogEl) {
    if (!dialogEl) return false;
    var text = (dialogEl.textContent || '').trim();
    if (!text) return false;

    if (/Are you sure you want to (?:delete|remove) the (?:project|workspace)\b/i.test(text)) {
      return true;
    }

    if (typeof dialogEl.querySelectorAll === 'function') {
      var headings = dialogEl.querySelectorAll('h1, h2, h3, [role="heading"]');
      for (var i = 0; i < headings.length; i++) {
        var ht = (headings[i].textContent || '').trim();
        if (/^(?:Delete|Remove)\s+(?:Project|Workspace)$/i.test(ht)) {
          return true;
        }
      }
    }
    return false;
  }

  function findConfirmButton(dialogEl) {
    if (!dialogEl || typeof dialogEl.querySelectorAll !== 'function') return null;
    var buttons = dialogEl.querySelectorAll('button');
    var fallback = null;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var label = (btn.textContent || '').trim();
      if (/^(?:Delete|Remove)$/i.test(label)) {
        if (btn.getAttribute && btn.getAttribute('data-autofocus') === 'true') {
          return btn;
        }
        fallback = btn;
      }
    }
    return fallback;
  }

  function injectIntoDialog(dialogEl) {
    if (!dialogEl || !dialogEl.getAttribute) return false;
    if (dialogEl.getAttribute(DIALOG_ATTR) === 'true') return false;
    if (!isProjectDeleteDialog(dialogEl)) return false;

    var confirmBtn = findConfirmButton(dialogEl);
    if (!confirmBtn) return false;

    var folderPath = resolveLocalFolderPath(dialogEl);
    if (!folderPath) {
      // Remote project or non-local/protected path: never show checkbox.
      return false;
    }

    var doc = dialogEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return false;
    ensureStyles(doc);

    var footerRow = confirmBtn.parentElement;
    if (!footerRow || !footerRow.parentElement) return false;

    var row = doc.createElement('label');
    row.className = 'agy-del-folder-row';
    row.setAttribute(ROW_ATTR, 'true');
    row.setAttribute('data-testid', 'agy-delete-folder-row');
    row.setAttribute('data-checked', 'false');

    var checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    checkbox.className = 'agy-del-folder-cb';
    checkbox.setAttribute(CHECKBOX_ATTR, 'true');
    checkbox.setAttribute('data-testid', 'agy-delete-folder-checkbox');

    var textWrap = doc.createElement('span');
    textWrap.className = 'agy-del-folder-text';

    var titleSpan = doc.createElement('span');
    titleSpan.className = 'agy-del-folder-label';
    titleSpan.textContent = 'Also delete project folder from storage';

    var pathSpan = doc.createElement('span');
    pathSpan.className = 'agy-del-folder-path';
    pathSpan.setAttribute('title', folderPath);
    pathSpan.setAttribute('data-testid', 'agy-delete-folder-path');
    pathSpan.textContent = formatCompactPath(folderPath);

    textWrap.appendChild(titleSpan);
    textWrap.appendChild(pathSpan);
    row.appendChild(checkbox);
    row.appendChild(textWrap);

    var syncCheckedStyle = function () {
      row.setAttribute('data-checked', checkbox.checked ? 'true' : 'false');
    };
    if (typeof checkbox.addEventListener === 'function') {
      checkbox.addEventListener('change', syncCheckedStyle);
    }

    var triggered = false;
    var triggerDeleteIfChecked = function () {
      if (triggered) return;
      if (!checkbox.checked) return;
      triggered = true;
      var env = getBridgeEnv();
      if (!env) return;
      try {
        env.bridge.deleteProjectFolder(env.token, folderPath);
      } catch (ignored) {}
    };

    if (typeof confirmBtn.addEventListener === 'function') {
      confirmBtn.addEventListener('click', triggerDeleteIfChecked, true);
    }
    if (typeof dialogEl.addEventListener === 'function') {
      dialogEl.addEventListener('keydown', function (ev) {
        if (!ev || ev.key !== 'Enter') return;
        var target = ev.target;
        if (target && target.tagName === 'BUTTON' && target !== confirmBtn) return;
        triggerDeleteIfChecked();
      }, true);
    }

    footerRow.parentElement.insertBefore(row, footerRow);
    dialogEl.setAttribute(DIALOG_ATTR, 'true');
    return true;
  }

  function scan() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return 0;
    }
    var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .agy-dialog');
    var count = 0;
    for (var i = 0; i < dialogs.length; i++) {
      if (injectIntoDialog(dialogs[i])) {
        count++;
      }
    }
    return count;
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    var run = function () {
      scanScheduled = false;
      scan();
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(run);
    } else if (typeof setTimeout === 'function') {
      setTimeout(run, 0);
    } else {
      run();
    }
  }

  function install() {
    scan();
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      var target = document.body || document.documentElement;
      if (target) {
        try {
          var observer = new MutationObserver(function () {
            scheduleScan();
          });
          observer.observe(target, { childList: true, subtree: true });
        } catch (ignored) {}
      }
    }
  }

  global.__agProjectDeleteFolder = {
    scan: scan,
    resolveLocalFolderPath: resolveLocalFolderPath,
    normalizeLocalPath: normalizeLocalPath,
    formatCompactPath: formatCompactPath
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading' &&
      typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
}
