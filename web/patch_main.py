#!/usr/bin/env python3
"""
web/patch_main.py - Dynamic patcher for web/main.js.

Locates the Appearance settings block and injects the Desktop Mode toggle,
and integrates the Account Vault & Switcher into Settings -> Accounts and
Settings -> Account. Safe, idempotent, and resilient to upstream changes.
"""

import sys
import os
import re

def patch_main(file_path):
    if not os.path.isfile(file_path):
        print(f"[web-patch] file not found: {file_path}", file=sys.stderr)
        return False

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    modified = False

    # Fix voice left_home unmount abort bug
    target_unmount = 'E.current!==YU||DU||kV("left_home")'
    replacement_unmount = 'E.current!==YU||DU||XU||kV("left_home")'
    if target_unmount in content:
        content = content.replace(target_unmount, replacement_unmount)
        print("[web-patch] Patched voice left_home unmount race condition")
        modified = True

    # Separate AbortError from NotReadableError in microphone error handler
    err_anchor = 'case "NotReadableError":case "AbortError":'
    err_idx = content.find(err_anchor)
    if err_idx != -1:
        err_win = content[err_idx:min(len(content), err_idx + 200)]
        err_m = re.search(
            r'case "NotReadableError":case "AbortError":return ([A-Za-z0-9_$]+)\("Microphone is in use or unavailable\."\);',
            err_win,
        )
        if err_m:
            err_fn = err_m.group(1)
            content = content.replace(
                err_m.group(0),
                f'case "NotReadableError":return {err_fn}("Microphone is in use or unavailable.");'
                f'case "AbortError":return {err_fn}("Microphone connection was aborted. Please retry.");',
                1,
            )
            print("[web-patch] Patched voice AbortError message")
            modified = True

    # Use Blob URL fallback for AudioWorklet addModule
    wk_anchor = '.audioWorklet.addModule("data:application/javascript;base64,"+btoa('
    wk_idx = content.find(wk_anchor)
    if wk_idx != -1:
        wk_win = content[max(0, wk_idx - 120):min(len(content), wk_idx + 120)]
        worklet_m = re.search(
            r'([A-Za-z0-9_$]+)\(await ([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.audioWorklet\.addModule\("data:application/javascript;base64,"\+btoa\(([A-Za-z0-9_$]+)\)\)\)\)',
            wk_win,
        )
        if worklet_m:
            cb, await_fn, ctx_var, src_var = worklet_m.groups()
            content = content.replace(
                worklet_m.group(0),
                f'{cb}(await {await_fn}({ctx_var}.audioWorklet.addModule('
                f'window.URL&&window.Blob?URL.createObjectURL(new Blob([{src_var}],{{type:"application/javascript"}})):'
                f'"data:application/javascript;base64,"+btoa({src_var}))))',
                1,
            )
            print("[web-patch] Patched audioWorklet addModule to use Blob URL fallback")
            modified = True

    # Ensure any pre-existing setDesktopMode(v) call passes the native bridge token.
    legacy_desktop_call = "if(window.Android&&typeof window.Android.setDesktopMode==='function')window.Android.setDesktopMode(v)"
    tokenized_desktop_call = "if(window.Android&&typeof window.Android.setDesktopMode==='function')window.Android.setDesktopMode(window.__AG_NATIVE_BRIDGE_TOKEN__||'',v)"
    if legacy_desktop_call in content:
        content = content.replace(legacy_desktop_call, tokenized_desktop_call)
        print("[web-patch] Upgraded legacy setDesktopMode(v) call to include bridge token")
        modified = True

    # Force plugin OAuth sign-in mode to PLUGIN_AUTH_SIGN_IN_MODE_REDIRECT (1) instead of
    # PLUGIN_AUTH_SIGN_IN_MODE_PASTE (2). Upstream returns 2 for Web/Cider hosts, which uses
    # https://antigravity.google/oauth-callback and fails with Google OAuth redirect_uri_mismatch.
    # On AGY Android, language_server runs locally on 127.0.0.1 so localhost redirect (1) works.
    oauth_mode_pattern = re.compile(
        r'function\s+([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\)\{'
        r'\2=\2\?\.host;'
        r'return\s+\2!==void 0&&\(([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.Web,\2\)\|\|\3\(\4\.Extension\.Cider,\2\)\)\?2:1\}'
    )
    content, oauth_count = oauth_mode_pattern.subn(r'function \1(\2){return 1}', content)
    if oauth_count > 0:
        print(f"[web-patch] Patched plugin OAuth sign-in mode to REDIRECT (1) ({oauth_count} match)")
        modified = True

    if "Desktop Mode" in content or "ag_desktop_mode" in content:
        print("[web-patch] Desktop Mode toggle already present in main.js")
    else:
        content, ok = inject_desktop_mode(content)
        if not ok:
            return False
        modified = True

    if "__agAccountSwitcher" in content or "AgAccountsScreen" in content:
        print("[web-patch] Account Switcher already present in main.js")
    else:
        content, ok = inject_account_switcher(content)
        if not ok:
            return False
        modified = True

    if modified:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

    return True


def inject_desktop_mode(content):

    # 1. JSX Theme element injection: find Theme element in Appearance
    theme_idx = content.find('{label:"Theme"')
    theme_match = None
    react_id = "A"
    if theme_idx != -1:
        # Search backwards within a reasonable window for createElement
        window_start = max(0, theme_idx - 100)
        window_end = min(len(content), theme_idx + 500)
        window_text = content[window_start:window_end]
        theme_pattern = re.compile(
            r'([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{label:"Theme",.*?onSelect:[A-Za-z0-9_$]+\}\)'
        )
        theme_match = theme_pattern.search(window_text)
        if theme_match:
            react_id = theme_match.group(1)

    if not theme_match:
        print("[web-patch] pattern not matched: theme element not found", file=sys.stderr)
        return False

    # 2. State hook injection pattern in Appearance component:
    # Pattern A (legacy): Matches var C=g!==3,D=g!==2,E=F=>G=>{F===t&&v(G)};
    # Search within reasonable distance from theme_idx to avoid slow regex scanning
    search_window = content[max(0, theme_idx - 1200):theme_idx]
    hook_pattern = re.compile(r'(var\s+[A-Za-z0-9_$]+=[A-Za-z0-9_$]+!==3,\s*[A-Za-z0-9_$]+=[A-Za-z0-9_$]+!==2,\s*[A-Za-z0-9_$]+=[A-Za-z0-9_$]+=>\s*[A-Za-z0-9_$]+=>\{.*?\};)')
    hook_match = hook_pattern.search(search_window)

    ret_target = None
    if not hook_match:
        # Pattern B (v2.33.0+): Hook right before the component return statement
        ret_needle = f"return {react_id}.createElement("
        if ret_needle in search_window:
            ret_target = ret_needle

    if not hook_match and not ret_target:
        print(f"[web-patch] patterns not matched: hook=False, ret_target=False", file=sys.stderr)
        return False

    hook_code = (
        f"var [isDesktop,setIsDesktop]=(0,{react_id}.useState)(()=>{{"
        "try{if(window.Android&&typeof window.Android.isDesktopMode==='function')return window.Android.isDesktopMode();"
        "var s=localStorage.getItem('ag_desktop_mode');return s===null?!1:s==='true'}catch(_){return !1}});"
        f"var onDesktopToggle=(0,{react_id}.useCallback)(v=>{{"
        "setIsDesktop(v);try{localStorage.setItem('ag_desktop_mode',String(v));"
        "if(window.Android&&typeof window.Android.setDesktopMode==='function')window.Android.setDesktopMode(window.__AG_NATIVE_BRIDGE_TOKEN__||'',v)}catch(_){}},[]);"
    )

    # Detect switch and setting item components
    item_comp = "v3"
    switch_comp = "dX"
    sw_m = re.search(r'createElement\(([A-Za-z0-9_$]+),\{[^\}]*label:[^,]+,[^\}]*rightElement:([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{checked:', content)
    if sw_m:
        item_comp = sw_m.group(1)
        switch_comp = sw_m.group(3)
    else:
        # Fallback to secondary pattern
        re_idx = content.find('rightElement:')
        if re_idx != -1:
            re_window = content[max(0, re_idx - 150):min(len(content), re_idx + 150)]
            item_m = re.search(r'([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{label:[^,]+,description:[^,]+,rightElement:', re_window)
            if item_m:
                item_comp = item_m.group(2)
            sw_m2 = re.search(r'rightElement:[A-Za-z0-9_$]+\.createElement\(([A-Za-z0-9_$]+),\{checked:', re_window)
            if sw_m2:
                switch_comp = sw_m2.group(1)

    orig_theme = theme_match.group(0)
    injected_theme = (
        orig_theme
        + f',{react_id}.createElement({item_comp},{{label:"Desktop Mode",description:"Use desktop viewport and user agent for the workspace",'
        + f'rightElement:{react_id}.createElement({switch_comp},{{checked:isDesktop,onCheckedChange:onDesktopToggle}})}})'
    )

    if hook_match:
        orig_hook = hook_match.group(1)
        content = content.replace(orig_hook, hook_code + orig_hook, 1)
    else:
        pre_theme = content[:theme_idx]
        post_theme = content[theme_idx:]
        last_ret_pos = pre_theme.rfind(ret_target)
        if last_ret_pos == -1:
            print("[web-patch] failed to locate return statement before theme element", file=sys.stderr)
            return False
        pre_theme = pre_theme[:last_ret_pos] + hook_code + ret_target + pre_theme[last_ret_pos + len(ret_target):]
        content = pre_theme + post_theme

    content = content.replace(orig_theme, injected_theme, 1)

    print("[web-patch] Successfully patched Desktop Mode toggle into main.js (mobile by default, English)")
    return content, True


def inject_account_switcher(content):
    # 1. Discover Settings & auth symbols dynamically using bounded slices
    gob_idx = content.find("Manage your plan, credentials, and general preferences.")
    if gob_idx == -1:
        print("[web-patch] account switcher: GOb anchor not found", file=sys.stderr)
        return content, False
    gob_win = content[max(0, gob_idx - 2500):min(len(content), gob_idx + 4500)]

    gob_m = re.search(
        r'var\s+([A-Za-z0-9_$]+)=\(\{isActive:[A-Za-z0-9_$]+\}=\{\}\)=>\{var\s+([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\(\)\.core\.authService\b',
        gob_win,
    )
    if not gob_m:
        print("[web-patch] account switcher: GOb header pattern not matched", file=sys.stderr)
        return content, False

    auth_svc_var = gob_m.group(2)
    sd_fn = gob_m.group(3)
    gob_hdr_tail = gob_win[gob_m.start():min(len(gob_win), gob_m.start() + 900)]

    sel_m = re.search(
        r'([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\),([A-Za-z0-9_$]+)=\2\(([A-Za-z0-9_$]+)\)',
        gob_hdr_tail,
    )
    if not sel_m:
        print("[web-patch] account switcher: GOb selector bindings not matched", file=sys.stderr)
        return content, False
    user_status_var, el_fn, sb_sel, auth_state_var, xk_sel = sel_m.groups()

    rc_m = re.search(r'([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)\.get\("isRemoteControl"\)\?\?!1', gob_hdr_tail)
    nj_call_m = re.search(
        rf'\b{re.escape(rc_m.group(2))}=([A-Za-z0-9_$]+)\(\)' if rc_m else r'([A-Za-z0-9_$]+)=\1\(\)',
        gob_hdr_tail,
    ) if rc_m else None
    if not rc_m or not nj_call_m:
        print("[web-patch] account switcher: GOb remote-control settings binding not matched", file=sys.stderr)
        return content, False
    is_rc_var = rc_m.group(1)
    nj_fn = nj_call_m.group(1)

    gob_tail_preview = content[gob_idx:min(len(content), gob_idx + 5200)]
    login_click_m = re.search(
        rf'onClick:\(\)=>\{{([A-Za-z0-9_$]+)\(\);{re.escape(auth_svc_var)}\.showLoginFlow\(\)\}}',
        gob_tail_preview,
    )
    close_hook_m = re.search(
        rf'\b{re.escape(login_click_m.group(1))}=([A-Za-z0-9_$]+)\(\)(\.useCloseSettings\(\))?',
        gob_hdr_tail,
    ) if login_click_m else None
    if not login_click_m or not close_hook_m:
        print("[web-patch] account switcher: GOb closeSettings hook not matched", file=sys.stderr)
        return content, False
    close_settings_var = login_click_m.group(1)
    close_settings_expr = f"{close_hook_m.group(1)}(){close_hook_m.group(2) or ''}"

    # Locate LU, PU, NU, OU, BI, Dgb, Ew, eE, react_id
    lu_m = re.search(
        r'([A-Za-z0-9_$]+)\.createElement\(([A-Za-z0-9_$]+),\{title:"Account",description:"Manage your plan, credentials, and general preferences\."\},.*?'
        r'\1\.createElement\(([A-Za-z0-9_$]+),\{title:"Account"\},.*?'
        r'\1\.createElement\(([A-Za-z0-9_$]+),null,[A-Za-z0-9_$]+&&\1\.createElement\(([A-Za-z0-9_$]+),',
        gob_win,
        re.DOTALL,
    )
    if not lu_m:
        print("[web-patch] account switcher: LU/PU/NU/OU pattern not matched", file=sys.stderr)
        return content, False
    react_id = lu_m.group(1)
    lu_comp = lu_m.group(2)
    pu_comp = lu_m.group(3)
    nu_comp = lu_m.group(4)
    ou_comp = lu_m.group(5)

    bi_m = re.search(
        rf'{re.escape(react_id)}\.createElement\(([A-Za-z0-9_$]+),\{{variant:"secondary",size:"sm","data-testid":"g1-referral-invite-button"',
        gob_win,
        re.DOTALL,
    )
    if not bi_m:
        print("[web-patch] account switcher: BI button component not matched", file=sys.stderr)
        return content, False
    bi_comp = bi_m.group(1)

    nav_idx = content.find('"settings-nav-item-Account"')
    if nav_idx == -1:
        print("[web-patch] account switcher: settings-nav-item-Account not found", file=sys.stderr)
        return content, False
    dgb_m = re.search(
        rf'{re.escape(react_id)}\.createElement\(([A-Za-z0-9_$]+),\{{src:',
        content[nav_idx:min(len(content), nav_idx + 400)],
        re.DOTALL,
    )
    if not dgb_m:
        print("[web-patch] account switcher: Dgb avatar component not matched", file=sys.stderr)
        return content, False
    dgb_comp = dgb_m.group(1)

    ew_idx = content.find('name:"arrow_back"')
    if ew_idx == -1:
        print("[web-patch] account switcher: arrow_back icon not found", file=sys.stderr)
        return content, False
    ew_m = re.search(
        rf'{re.escape(react_id)}\.createElement\(([A-Za-z0-9_$]+),\{{name:"arrow_back"',
        content[max(0, ew_idx - 80):min(len(content), ew_idx + 40)],
        re.DOTALL,
    )
    if not ew_m:
        print("[web-patch] account switcher: Ew icon component not matched", file=sys.stderr)
        return content, False
    ew_comp = ew_m.group(1)

    ee_idx = content.find('"confirm-delete-all-user-data"')
    if ee_idx == -1:
        print("[web-patch] account switcher: confirm-delete-all-user-data not found", file=sys.stderr)
        return content, False
    ee_m = re.search(
        rf'{re.escape(react_id)}\.createElement\(([A-Za-z0-9_$]+),\{{size:16\}}',
        content[ee_idx:min(len(content), ee_idx + 300)],
        re.DOTALL,
    )
    if not ee_m:
        print("[web-patch] account switcher: eE spinner component not matched", file=sys.stderr)
        return content, False
    ee_comp = ee_m.group(1)

    # Locate cl (useStore) and K_b (refreshUserStatus hook)
    kb_idx = content.find('[UserStatusSync] Failed to fetch user status:')
    if kb_idx == -1:
        print("[web-patch] account switcher: UserStatusSync anchor not found", file=sys.stderr)
        return content, False
    kb_win = content[kb_idx:min(len(content), kb_idx + 1200)]
    kb_m = re.search(
        rf'function\s+([A-Za-z0-9_$]+)\(\)\{{var\s+[A-Za-z0-9_$]+=([A-Za-z0-9_$]+)\(\),[A-Za-z0-9_$]+=\(0,{re.escape(react_id)}\.useContext\)',
        kb_win,
        re.DOTALL,
    )
    if not kb_m:
        print("[web-patch] account switcher: K_b / cl hook pattern not matched", file=sys.stderr)
        return content, False
    kb_fn = kb_m.group(1)
    cl_fn = kb_m.group(2)

    # 2. Auto-capture hook inside I_b when getUserStatus succeeds
    ib_win = content[max(0, kb_idx - 800):kb_idx]
    ib_m = re.search(
        r'(function\s+[A-Za-z0-9_$]+\(\{agentService:[A-Za-z0-9_$]+,store:([A-Za-z0-9_$]+),.*?'
        r'\{userStatus:([A-Za-z0-9_$]+)\}=[^;]+;if\(![A-Za-z0-9_$]+\(\)\)\{if\(\3\)\{)',
        ib_win,
        re.DOTALL,
    )
    if not ib_m:
        print("[web-patch] account switcher: I_b userStatus sync hook not matched", file=sys.stderr)
        return content, False
    ib_prefix = ib_m.group(1)
    ib_store = ib_m.group(2)
    ib_status = ib_m.group(3)
    ib_hook = f"try{{window.__agAccountSwitcher&&{ib_status}.email&&window.__agAccountSwitcher.syncProfile({ib_status},{xk_sel}({ib_store}.getState())?.context)}}catch(_){{}}"
    content = content.replace(ib_prefix, ib_prefix + ib_hook, 1)

    # 3. Inject hooks & Saved Accounts section into GOb (Account settings screen)
    # Must patch specifically at GOb's header (gob_m) — NOT global replace, because
    # earlier components like xOb also start with `var b=sd().core.authService`.
    gob_win_offset = max(0, gob_idx - 2500)
    gob_abs_start = gob_win_offset + gob_m.start()
    gob_header_str = gob_m.group(0)
    gob_anchor_prefix = f"var {auth_svc_var}={sd_fn}().core.authService"
    gob_hooks = (
        f"var _agStore={cl_fn}(),_agRefreshStatus={kb_fn}(),"
        f"_agAuthState={el_fn}({xk_sel}),_agRc={nj_fn}().get(\"isRemoteControl\")??!1;"
    )
    if gob_anchor_prefix not in gob_header_str:
        print("[web-patch] account switcher: GOb hook anchor missing in GOb header", file=sys.stderr)
        return content, False
    patched_gob_header = gob_header_str.replace(gob_anchor_prefix, gob_hooks + gob_anchor_prefix, 1)
    content = content[:gob_abs_start] + patched_gob_header + content[gob_abs_start + len(gob_header_str):]

    gob_tail_win = content[gob_idx:min(len(content), gob_idx + 5200)]
    gob_tail_m = re.search(
        r'("Sign In"\)\}\)\)\)\)),([A-Za-z0-9_$]+&&[A-Za-z0-9_$]+&&' + re.escape(react_id) + r'\.createElement\([A-Za-z0-9_$]+,\{deleteAllUserData:[A-Za-z0-9_$]+\}\))',
        gob_tail_win,
        re.DOTALL,
    )
    if not gob_tail_m:
        print("[web-patch] account switcher: GOb Saved Accounts insertion anchor not matched", file=sys.stderr)
        return content, False
    section_call = (
        f"(window.__agAccountSwitcher?window.__agAccountSwitcher.renderSection({{"
        f"React:{react_id},LU:{lu_comp},PU:{pu_comp},NU:{nu_comp},OU:{ou_comp},"
        f"BI:{bi_comp},Dgb:{dgb_comp},Ew:{ew_comp},eE:{ee_comp},"
        f"userStatus:{user_status_var},authState:_agAuthState,authService:{auth_svc_var},"
        f"refreshUserStatus:_agRefreshStatus,getStoreState:()=>_agStore.getState(),"
        f"closeSettings:{close_settings_var},isRemoteControl:_agRc}}):null)"
    )
    content = content.replace(
        gob_tail_m.group(0),
        f"{gob_tail_m.group(1)},{section_call},{gob_tail_m.group(2)}",
        1,
    )

    # 4. Register "Accounts" screen in Settings navigation (wMb, xMb, oXb)
    wmb_target = '[{screen:"General"},'
    wmb_idx = content.find(wmb_target)
    if wmb_idx == -1:
        print("[web-patch] account switcher: wMb screen list not matched", file=sys.stderr)
        return content, False
    content = content.replace(wmb_target, '[{screen:"General"},{screen:"Accounts",label:"Accounts"},', 1)

    xmb_m = re.search(
        r'(function\s+[A-Za-z0-9_$]+\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)\{return\s+[A-Za-z0-9_$]+\.map\(([A-Za-z0-9_$]+)=>\4\.screen\)\.filter\(\4=>)(\(!([A-Za-z0-9_$]+)\.includes\(\4\)\|\|\3\.includes\(\4\)\)&&\2\(\4\)\)\})',
        content[wmb_idx:min(len(content), wmb_idx + 700)],
        re.DOTALL,
    )
    if not xmb_m:
        print("[web-patch] account switcher: xMb filter pattern not matched", file=sys.stderr)
        return content, False
    xmb_c = xmb_m.group(4)
    content = content.replace(
        xmb_m.group(0),
        f"{xmb_m.group(1)}{xmb_c}===\"Accounts\"||{xmb_m.group(5)}",
        1,
    )

    oxb_idx = content.find('case "Account":return')
    if oxb_idx == -1:
        print("[web-patch] account switcher: oXb case Account not found", file=sys.stderr)
        return content, False
    oxb_m = re.search(
        r'(function\s+[A-Za-z0-9_$]+\([A-Za-z0-9_$]+,[A-Za-z0-9_$]+=!0\)\{.*?switch\([A-Za-z0-9_$]+\)\{)(case\s+"Account":)',
        content[max(0, oxb_idx - 200):min(len(content), oxb_idx + 60)],
        re.DOTALL,
    )
    if not oxb_m:
        print("[web-patch] account switcher: oXb switch pattern not matched", file=sys.stderr)
        return content, False

    ag_screen_comp = (
        f"function AgAccountsScreen(){{"
        f"var _u={el_fn}({sb_sel}),_au={el_fn}({xk_sel}),_as={sd_fn}().core.authService,"
        f"_rf={kb_fn}(),_st={cl_fn}(),_cs={close_settings_expr},"
        f"_rc={nj_fn}().get(\"isRemoteControl\")??!1;"
        f"return window.__agAccountSwitcher?window.__agAccountSwitcher.renderScreen({{"
        f"React:{react_id},LU:{lu_comp},PU:{pu_comp},NU:{nu_comp},OU:{ou_comp},"
        f"BI:{bi_comp},Dgb:{dgb_comp},Ew:{ew_comp},eE:{ee_comp},"
        f"userStatus:_u,authState:_au,authService:_as,"
        f"refreshUserStatus:_rf,getStoreState:()=>_st.getState(),"
        f"closeSettings:_cs,isRemoteControl:_rc}}):null}}"
    )
    content = content.replace(
        oxb_m.group(0),
        f"{ag_screen_comp}{oxb_m.group(1)}case \"Accounts\":return {react_id}.createElement(AgAccountsScreen,null);{oxb_m.group(2)}",
        1,
    )

    print("[web-patch] Successfully patched Account Switcher into Settings -> Accounts and Account")
    return content, True

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "main.js")
    if not patch_main(path):
        sys.exit(1)
