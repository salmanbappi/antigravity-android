#!/usr/bin/env python3
"""High-speed core engine for AGY pkg (index, vercmp, resolver, db, deb stage-install)."""

from __future__ import annotations

import argparse
import hashlib
import io
import lzma
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
from typing import Dict, List, Optional, Tuple

sys.dont_write_bytecode = True

PREFIX_RE_BYTES = re.compile(rb"/data/(?:data|user/[0-9]+)/[^/\s'\";:<>()]*/files/usr")
PREFIX_RE_STR = re.compile(r"/data/(?:data|user/[0-9]+)/[^/\s'\";:<>()]*/files/usr")
TERMUX_DATA_PREFIX_RE = re.compile(
    r"^(?:\./)?data/(?:data|user/[0-9]+)/[A-Za-z0-9][A-Za-z0-9+._-]*/files/usr(?:/(.*))?$"
)
PKG_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+._-]*$")
VER_CONSTRAINT_RE = re.compile(r"^([^\s(\[:]+)\s*(?:\(([^)]+)\))?")


def _is_letter(ch: str) -> bool:
    return ("A" <= ch <= "Z") or ("a" <= ch <= "z")


def _is_digit(ch: str) -> bool:
    return "0" <= ch <= "9"


def _ord_char(ch: str) -> int:
    if not ch:
        return 0
    if ch == "~":
        return -1
    if _is_letter(ch):
        return ord(ch)
    return ord(ch) + 256


def _verrevcmp(s: str, t: str) -> int:
    la, lb = len(s), len(t)
    i = j = 0
    while i < la or j < lb:
        while (i < la and not _is_digit(s[i])) or (j < lb and not _is_digit(t[j])):
            ca = s[i] if i < la else ""
            cb = t[j] if j < lb else ""
            if not ca and not cb:
                break
            oa, ob = _ord_char(ca), _ord_char(cb)
            if oa != ob:
                return -1 if oa < ob else 1
            i += 1
            j += 1
        while i < la and s[i] == "0":
            i += 1
        while j < lb and t[j] == "0":
            j += 1
        si, sj = i, j
        while i < la and _is_digit(s[i]):
            i += 1
        while j < lb and _is_digit(t[j]):
            j += 1
        da, db = s[si:i], t[sj:j]
        if len(da) != len(db):
            return -1 if len(da) < len(db) else 1
        if da != db:
            return -1 if da < db else 1
    return 0


def vercmp(a: str, b: str) -> int:
    def split_epoch_rev(v: str) -> Tuple[int, str, str]:
        epoch = 0
        if ":" in v:
            e_str, v = v.split(":", 1)
            epoch = int(e_str) if e_str.isdigit() else 0
        if "-" in v:
            up, rev = v.rsplit("-", 1)
        else:
            up, rev = v, ""
        return epoch, up, rev

    ea, ua, ra = split_epoch_rev(a)
    eb, ub, rb = split_epoch_rev(b)
    if ea != eb:
        return -1 if ea < eb else 1
    r = _verrevcmp(ua, ub)
    if r != 0:
        return r
    return _verrevcmp(ra, rb)


def ver_satisfies(ver: str, op: str, want: str) -> bool:
    c = vercmp(ver, want)
    if op == ">=":
        return c != -1
    if op == "<=":
        return c != 1
    if op in ("=", "=="):
        return c == 0
    if op in (">>", ">"):
        return c == 1
    if op in ("<<", "<"):
        return c == -1
    return True


def parse_packages_to_tsv(packages_path: str, tsv_path: Optional[str] = None) -> List[str]:
    rows: List[str] = []
    fields: Dict[str, str] = {}
    last = ""

    def emit() -> None:
        pkg = fields.get("Package", "")
        if not pkg:
            return
        cols = [
            pkg,
            fields.get("Version", ""),
            fields.get("Architecture", ""),
            fields.get("Essential", ""),
            fields.get("Depends", "").replace("\t", " "),
            fields.get("Pre-Depends", "").replace("\t", " "),
            fields.get("Provides", "").replace("\t", " "),
            fields.get("Conflicts", "").replace("\t", " "),
            fields.get("Filename", ""),
            fields.get("Size", ""),
            fields.get("SHA256", ""),
        ]
        rows.append("\t".join(cols))

    with open(packages_path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if not line:
                emit()
                fields.clear()
                last = ""
            elif line[0] in (" ", "\t"):
                if last in ("Depends", "Pre-Depends", "Provides", "Conflicts"):
                    prev = fields.get(last, "")
                    fields[last] = (prev + " " + line[1:]) if prev else line[1:]
            else:
                idx = line.find(":")
                if idx <= 0:
                    continue
                k = line[:idx]
                v = line[idx + 1:].lstrip(" \t")
                fields[k] = v
                last = k
    emit()

    if tsv_path:
        tmp = f"{tsv_path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as out:
            if rows:
                out.write("\n".join(rows) + "\n")
        os.replace(tmp, tsv_path)
    return rows


def ensure_indexes_fresh(pkg_index: str, force: bool = False) -> List[str]:
    tsvs: List[str] = []
    if not os.path.isdir(pkg_index):
        return tsvs
    for fn in sorted(os.listdir(pkg_index)):
        if not (fn.startswith("repo.") and fn.endswith(".Packages")):
            continue
        p_path = os.path.join(pkg_index, fn)
        t_path = os.path.join(pkg_index, fn[:-len(".Packages")] + ".tsv")
        need = force or not os.path.isfile(t_path) or os.path.getsize(t_path) == 0
        if not need:
            try:
                if os.stat(t_path).st_mtime_ns < os.stat(p_path).st_mtime_ns:
                    need = True
            except OSError:
                need = True
        if need:
            parse_packages_to_tsv(p_path, t_path)
        tsvs.append(t_path)
    return tsvs


def load_installed_db(pkg_db: str) -> Dict[str, str]:
    installed: Dict[str, str] = {}
    if not os.path.isdir(pkg_db):
        return installed
    for fn in os.listdir(pkg_db):
        if not fn.endswith(".meta"):
            continue
        name = fn[:-5]
        ver = ""
        try:
            with open(os.path.join(pkg_db, fn), "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("version="):
                        ver = line[8:].strip()
                        break
        except OSError:
            continue
        installed[name] = ver
    return installed


def sync_dpkg_status(prefix: str, pkg_db: str) -> int:
    status_path = os.path.join(prefix, "var", "lib", "dpkg", "status")
    if not os.path.isfile(status_path):
        return 0
    os.makedirs(pkg_db, exist_ok=True)
    stamp_path = os.path.join(pkg_db, ".dpkg_sync.stamp")
    st = os.stat(status_path)
    sig = f"{st.st_mtime_ns}:{st.st_size}"
    try:
        if os.path.isfile(stamp_path):
            with open(stamp_path, "r", encoding="utf-8") as sf:
                if sf.read().strip() == sig:
                    return 0
    except OSError:
        pass

    added = 0
    pkg = ver = arch = status = ""

    def flush() -> None:
        nonlocal added
        if pkg and ver and status.endswith("installed"):
            meta_path = os.path.join(pkg_db, f"{pkg}.meta")
            files_path = os.path.join(pkg_db, f"{pkg}.files")
            if not os.path.isfile(meta_path):
                tmp_m = f"{meta_path}.tmp.{os.getpid()}"
                tmp_f = f"{files_path}.tmp.{os.getpid()}"
                with open(tmp_m, "w", encoding="utf-8") as mf:
                    mf.write(f"name={pkg}\nversion={ver}\narch={arch or 'aarch64'}\n")
                with open(tmp_f, "w", encoding="utf-8"):
                    pass
                os.replace(tmp_m, meta_path)
                os.replace(tmp_f, files_path)
                added += 1

    with open(status_path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if not line:
                flush()
                pkg = ver = arch = status = ""
            elif line.startswith("Package: "):
                pkg = line[9:].strip()
            elif line.startswith("Version: "):
                ver = line[9:].strip()
            elif line.startswith("Architecture: "):
                arch = line[14:].strip()
            elif line.startswith("Status: "):
                status = line[8:].strip()
    flush()

    tmp_stamp = f"{stamp_path}.tmp.{os.getpid()}"
    with open(tmp_stamp, "w", encoding="utf-8") as sf:
        sf.write(sig + "\n")
    os.replace(tmp_stamp, stamp_path)
    return added


def load_index_map(pkg_index: str):
    tsvs = ensure_indexes_fresh(pkg_index)
    best: Dict[str, Tuple[str, List[str]]] = {}
    providers: Dict[str, List[str]] = {}
    repo_urls: Dict[str, str] = {}

    for tsv_path in tsvs:
        base = os.path.basename(tsv_path)[:-4]
        url_file = os.path.join(pkg_index, base + ".url")
        if os.path.isfile(url_file):
            with open(url_file, "r", encoding="utf-8", errors="replace") as uf:
                repo_urls[base] = uf.read().strip().rstrip("/")
        with open(tsv_path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line:
                    continue
                cols = line.split("\t")
                if len(cols) < 11:
                    continue
                name, ver = cols[0], cols[1]
                cur = best.get(name)
                if cur is None or vercmp(ver, cur[1][1]) == 1:
                    best[name] = (base, cols)
                prov = cols[6].strip()
                if prov:
                    for item in prov.split(","):
                        p = item.strip()
                        if p:
                            providers.setdefault(p, []).append(name)
    return best, providers, repo_urls


def resolve_packages(
    targets: List[str],
    best: Dict[str, Tuple[str, List[str]]],
    providers: Dict[str, List[str]],
    installed: Dict[str, str],
    force_upgrade: Optional[set] = None,
) -> Tuple[bool, List[str], str]:
    upgrade_set = force_upgrade if force_upgrade is not None else set()
    done: set = set()
    doing: set = set()
    order: List[str] = []

    def is_satisfied(name: str, op: str = "", want: str = "") -> bool:
        if name in upgrade_set:
            return False
        if name not in installed:
            return False
        if not want:
            return True
        return ver_satisfies(installed[name], op, want)

    def lookup_candidate(name: str) -> Optional[Tuple[str, List[str]]]:
        if name in best:
            return name, best[name][1]
        for prov in providers.get(name, ()):
            if prov in best:
                return prov, best[prov][1]
        return None

    def choose_dep(term: str) -> Optional[str]:
        for alt in term.split("|"):
            alt = alt.strip()
            if not alt:
                continue
            m = VER_CONSTRAINT_RE.match(alt)
            if not m:
                continue
            nm = m.group(1).split(":", 1)[0].strip()
            con = (m.group(2) or "").strip()
            op = want = ""
            if con:
                parts = con.split()
                if len(parts) >= 2:
                    op, want = parts[0], parts[1]
            if not nm:
                continue
            if is_satisfied(nm, op, want):
                return nm
            cand = lookup_candidate(nm)
            if cand is None:
                continue
            cname, cols = cand
            if want and not ver_satisfies(cols[1], op, want):
                continue
            if cname in installed:
                upgrade_set.add(cname)
            return cname
        return None

    def visit(name: str) -> Tuple[bool, str]:
        if not PKG_NAME_RE.match(name):
            return False, f"invalid package name: {name}"
        if name in done:
            return True, ""
        if name in installed and name not in upgrade_set:
            return True, ""
        if name in doing:
            return False, f"dependency cycle at: {name}"
        if name not in best:
            return False, f"unknown package in dependency closure: {name}"

        doing.add(name)
        cols = best[name][1]
        deps_raw = f"{cols[4]},{cols[5]}"
        for term in deps_raw.split(","):
            term = term.strip()
            if not term:
                continue
            cname = choose_dep(term)
            if not cname:
                doing.discard(name)
                return False, f"cannot resolve dependency: {term} (for {name})"
            ok, err = visit(cname)
            if not ok:
                doing.discard(name)
                return False, err
        doing.discard(name)
        done.add(name)
        order.append(name)
        return True, ""

    for t in targets:
        if not PKG_NAME_RE.match(t):
            return False, [], f"invalid package name: {t}"
        if t in installed and t not in upgrade_set:
            continue
        cand = lookup_candidate(t)
        if cand is None:
            return False, [], f"unknown package or provider: {t}"
        ok, err = visit(cand[0])
        if not ok:
            return False, [], err

    return True, order, ""


def ar_list_members(deb_path: str) -> List[Tuple[str, int, int]]:
    members: List[Tuple[str, int, int]] = []
    with open(deb_path, "rb") as f:
        magic = f.read(8)
        if magic != b"!<arch>\n":
            return members
        off = 8
        while True:
            f.seek(off)
            hdr = f.read(60)
            if len(hdr) < 60:
                break
            name = hdr[:16].decode("ascii", errors="replace").rstrip(" /")
            size_str = hdr[48:58].decode("ascii", errors="replace").strip()
            if not name or not size_str.isdigit():
                break
            size = int(size_str)
            data_off = off + 60
            members.append((name, data_off, size))
            off = data_off + size + (size % 2)
    return members


def _open_tar_stream_from_ar(deb_path: str, member_prefix: str):
    """Open decompressed tar stream + optional cleanup child/proc from an ar member."""
    dpkg_deb = shutil.which("dpkg-deb")
    if member_prefix == "data" and dpkg_deb:
        proc = subprocess.Popen(
            [dpkg_deb, "--fsys-tarfile", deb_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return proc.stdout, proc, None

    members = ar_list_members(deb_path)
    target = next((m for m in members if m[0].startswith(member_prefix + ".tar")), None)
    if target is None:
        raise ValueError(f"missing {member_prefix}.tar.* in {deb_path}")
    m_name, data_off, size = target

    with open(deb_path, "rb") as f:
        f.seek(data_off)
        raw = f.read(size)

    if m_name.endswith(".xz"):
        return io.BytesIO(lzma.decompress(raw)), None, None
    if m_name.endswith(".gz"):
        import gzip
        return io.BytesIO(gzip.decompress(raw)), None, None
    if m_name.endswith(".bz2"):
        import bz2
        return io.BytesIO(bz2.decompress(raw)), None, None
    if m_name.endswith(".zst"):
        proc = subprocess.Popen(
            ["zstd", "-dc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        out_bytes, err_bytes = proc.communicate(raw)
        if proc.returncode != 0:
            raise RuntimeError(err_bytes.decode("utf-8", errors="replace"))
        return io.BytesIO(out_bytes), None, None
    return io.BytesIO(raw), None, None


def strip_data_member_path(raw_path: str, strip_count: Optional[int] = None) -> Tuple[bool, str]:
    """
    Validate and strip prefix from a deb data tar entry.
    Handles both './data/data/<pkg>/files/usr/...' and 'data/data/<pkg>/files/usr/...'
    without relying on brittle fixed component counts unless custom strip_count != 6.
    """
    if not raw_path or raw_path.startswith("/") or "\\" in raw_path or "\x00" in raw_path:
        return False, ""
    if raw_path in (".", "./"):
        return True, ""

    parts = [p for p in raw_path.split("/") if p]
    if parts and parts[0] == ".":
        parts = parts[1:]
    if not parts:
        return True, ""
    if any(p in (".", "..") for p in parts):
        return False, ""

    if strip_count is not None and strip_count != 6:
        if len(parts) <= strip_count:
            return True, ""
        return True, "/".join(parts[strip_count:])

    m = TERMUX_DATA_PREFIX_RE.match(raw_path.rstrip("/"))
    if not m:
        # Allow parent directory prefixes of data/data/<pkg>/files/usr cleanly
        clean = "/".join(parts)
        if clean in ("data", "data/data", "data/user") or (
            parts[0] == "data"
            and (
                (len(parts) >= 2 and parts[1] == "data" and len(parts) <= 5 and (
                    len(parts) < 3 or PKG_NAME_RE.match(parts[2])
                ) and (len(parts) < 4 or parts[3] == "files") and (len(parts) < 5 or parts[4] == "usr"))
                or (len(parts) >= 3 and parts[1] == "user" and parts[2].isdigit() and len(parts) <= 6 and (
                    len(parts) < 4 or PKG_NAME_RE.match(parts[3])
                ) and (len(parts) < 5 or parts[4] == "files") and (len(parts) < 6 or parts[5] == "usr"))
            )
        ):
            return True, ""
        return False, ""

    rel = (m.group(1) or "").strip("/")
    return True, rel


def read_control_field(deb_path: str, field: str) -> str:
    dpkg_deb = shutil.which("dpkg-deb")
    if dpkg_deb:
        res = subprocess.run([dpkg_deb, "-f", deb_path, field], capture_output=True, text=True)
        if res.returncode == 0:
            return res.stdout.rstrip("\n")
    stream, proc, _ = _open_tar_stream_from_ar(deb_path, "control")
    try:
        with tarfile.open(fileobj=stream, mode="r|*") as tf:
            for member in tf:
                clean = member.name.lstrip("./")
                if clean == "control":
                    fobj = tf.extractfile(member)
                    if fobj is None:
                        return ""
                    text = fobj.read().decode("utf-8", errors="replace")
                    prefix = field + ":"
                    for line in text.splitlines():
                        if line.startswith(prefix):
                            return line[len(prefix):].lstrip(" \t")
                    return ""
    finally:
        if proc is not None:
            proc.wait()
    return ""


def _patch_staged_files(stage_dir: str, rel_files: List[str], prefix: str) -> None:
    prefix_bytes = prefix.encode("utf-8")
    m_pkg = re.search(r"/data/(?:data|user/[0-9]+)/([^/]+)/files/usr/?$", os.path.normpath(prefix))
    pkg_name = m_pkg.group(1) if m_pkg else ""
    padded_pkg = (pkg_name + "/" * max(0, 10 - len(pkg_name))) if pkg_name and len(pkg_name) <= 10 else ""
    rep_data = f"/data/data/{padded_pkg}".encode("latin1") if padded_pkg else b""
    rep_user = f"/data/user/0/{padded_pkg}".encode("latin1") if padded_pkg else b""

    for rel in rel_files:
        fpath = os.path.join(stage_dir, rel)
        if os.path.islink(fpath) or not os.path.isfile(fpath):
            continue
        try:
            st = os.stat(fpath)
            if st.st_size == 0:
                continue
            if st.st_size > 32 * 1024 * 1024:
                continue
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError:
            continue

        if data[:4] == b"\x7fELF":
            if padded_pkg and (b"/data/data/com.termux" in data or b"/data/user/0/com.termux" in data):
                new_data = data.replace(b"/data/data/com.termux", rep_data)
                new_data = new_data.replace(b"/data/user/0/com.termux", rep_user)
                if len(new_data) == len(data) and new_data != data:
                    _atomic_rewrite_bytes(fpath, new_data, st.st_mode)
            continue

        # Text check matching grep -I semantics (no NUL bytes in prefix sample)
        sample = data[:8192]
        if b"\x00" in sample:
            continue
        if b"/data/data/" in data or b"/data/user/" in data:
            new_data = PREFIX_RE_BYTES.sub(prefix_bytes, data)
            if new_data != data:
                _atomic_rewrite_bytes(fpath, new_data, st.st_mode)


def _atomic_rewrite_bytes(path: str, data: bytes, mode: int) -> None:
    tmp = f"{path}.agyrewrite.{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, stat.S_IMODE(mode))
    os.replace(tmp, path)


def _merge_stage_into_prefix(stage_dir: str, prefix: str, dir_modes: Dict[str, int]) -> None:
    # Create directories top-down
    for rel_dir in sorted(dir_modes.keys(), key=lambda x: x.count("/")):
        dst_dir = os.path.join(prefix, rel_dir)
        if os.path.islink(dst_dir) or (os.path.exists(dst_dir) and not os.path.isdir(dst_dir)):
            os.unlink(dst_dir)
        os.makedirs(dst_dir, exist_ok=True)

    for root, dirs, files in os.walk(stage_dir, topdown=True):
        rel_root = os.path.relpath(root, stage_dir)
        dst_root = prefix if rel_root == "." else os.path.join(prefix, rel_root)
        real_dirs: List[str] = []
        for d in dirs:
            src_d = os.path.join(root, d)
            dst_d = os.path.join(dst_root, d)
            if os.path.islink(src_d):
                if os.path.isdir(dst_d) and not os.path.islink(dst_d):
                    shutil.rmtree(dst_d)
                os.replace(src_d, dst_d)
                continue
            if os.path.islink(dst_d) or (os.path.exists(dst_d) and not os.path.isdir(dst_d)):
                os.unlink(dst_d)
            os.makedirs(dst_d, exist_ok=True)
            real_dirs.append(d)
        dirs[:] = real_dirs
        for fn in files:
            src_f = os.path.join(root, fn)
            dst_f = os.path.join(dst_root, fn)
            if os.path.isdir(dst_f) and not os.path.islink(dst_f):
                shutil.rmtree(dst_f)
            os.replace(src_f, dst_f)

    # Apply directory permissions after files are placed (bottom-up handles 0555 dirs)
    for rel_dir in sorted(dir_modes.keys(), key=lambda x: x.count("/"), reverse=True):
        dst_dir = os.path.join(prefix, rel_dir)
        if os.path.isdir(dst_dir) and not os.path.islink(dst_dir):
            try:
                os.chmod(dst_dir, stat.S_IMODE(dir_modes[rel_dir]) | 0o700)
            except OSError:
                pass


def stage_install_deb(
    deb_path: str,
    prefix: str,
    pkg_root: str,
    pkg_db: str,
    name: str,
    ver: str,
    arch: str,
    keep_cache: bool = False,
) -> List[str]:
    """Validate and extract deb into private staging dir, rewrite prefixes, merge atomically into PREFIX."""
    os.makedirs(os.path.join(pkg_root, "tmp"), exist_ok=True)
    stage_dir = os.path.join(pkg_root, "tmp", f"stage.{os.getpid()}.{name}")
    if os.path.exists(stage_dir):
        shutil.rmtree(stage_dir)
    os.makedirs(stage_dir, exist_ok=True)

    cver = read_control_field(deb_path, "Version")
    if cver:
        ver = cver

    extracted_files: List[str] = []
    dir_modes: Dict[str, int] = {}
    stream, proc, _ = _open_tar_stream_from_ar(deb_path, "data")
    try:
        with tarfile.open(fileobj=stream, mode="r|*") as tf:
            for member in tf:
                ok, rel = strip_data_member_path(member.name)
                if not ok:
                    raise ValueError(f"unsafe or invalid deb entry path: {member.name!r}")
                if not rel:
                    continue
                if member.isdir():
                    os.makedirs(os.path.join(stage_dir, rel), exist_ok=True)
                    dir_modes[rel] = member.mode or 0o755
                    continue

                dst_path = os.path.join(stage_dir, rel)
                parent_rel = posixpath.dirname(rel)
                if parent_rel:
                    os.makedirs(os.path.join(stage_dir, parent_rel), exist_ok=True)

                if member.issym():
                    link = member.linkname
                    if not link or "\x00" in link:
                        raise ValueError(f"invalid symlink target in {rel}")
                    if os.path.isabs(link):
                        m = PREFIX_RE_STR.match(link)
                        if m:
                            link = prefix + link[m.end():]
                    else:
                        resolved = posixpath.normpath(posixpath.join(parent_rel or ".", link))
                        if resolved == ".." or resolved.startswith("../"):
                            raise ValueError(f"escaping symlink target in {rel}: {link}")
                    if os.path.lexists(dst_path):
                        os.unlink(dst_path)
                    os.symlink(link, dst_path)
                    extracted_files.append(rel)
                elif member.islnk():
                    ok_l, target_rel = strip_data_member_path(member.linkname)
                    if not ok_l or not target_rel:
                        raise ValueError(f"unsafe hardlink target in {rel}: {member.linkname}")
                    target_path = os.path.join(stage_dir, target_rel)
                    if not os.path.exists(target_path):
                        raise ValueError(f"dangling hardlink target in {rel}: {target_rel}")
                    if os.path.lexists(dst_path):
                        os.unlink(dst_path)
                    os.link(target_path, dst_path)
                    extracted_files.append(rel)
                elif member.isreg():
                    fobj = tf.extractfile(member)
                    if fobj is None:
                        raise ValueError(f"cannot read regular file {rel}")
                    if os.path.lexists(dst_path):
                        os.unlink(dst_path)
                    with open(dst_path, "wb") as out:
                        shutil.copyfileobj(fobj, out, 256 * 1024)
                    os.chmod(dst_path, stat.S_IMODE(member.mode or 0o644) | 0o200)
                    extracted_files.append(rel)
                else:
                    raise ValueError(f"unsupported tar entry type for {rel}")
        if proc is not None:
            rc = proc.wait()
            if rc != 0:
                err = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
                raise RuntimeError(f"dpkg-deb failed ({rc}): {err}")

        _patch_staged_files(stage_dir, extracted_files, prefix)
        _merge_stage_into_prefix(stage_dir, prefix, dir_modes)
    except Exception:
        shutil.rmtree(stage_dir, ignore_errors=True)
        if proc is not None and proc.poll() is None:
            proc.kill()
        raise
    else:
        shutil.rmtree(stage_dir, ignore_errors=True)

    os.makedirs(pkg_db, exist_ok=True)
    unique_files = sorted(set(extracted_files))
    meta_path = os.path.join(pkg_db, f"{name}.meta")
    files_path = os.path.join(pkg_db, f"{name}.files")
    tmp_m = f"{meta_path}.tmp.{os.getpid()}"
    tmp_f = f"{files_path}.tmp.{os.getpid()}"
    with open(tmp_m, "w", encoding="utf-8") as mf:
        mf.write(f"name={name}\nversion={ver}\narch={arch}\n")
    with open(tmp_f, "w", encoding="utf-8") as ff:
        if unique_files:
            ff.write("\n".join(unique_files) + "\n")
    os.replace(tmp_m, meta_path)
    os.replace(tmp_f, files_path)

    _write_runtime_bridges(prefix, unique_files)
    if not keep_cache and os.path.isfile(deb_path):
        try:
            os.remove(deb_path)
        except OSError:
            pass
    return unique_files


def _is_agy_fallback_shim(path: str) -> bool:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("# AGY fallback"):
                    return True
    except OSError:
        return False
    return False


def _write_runtime_bridges(prefix: str, rel_files: List[str]) -> None:
    runtime_bin = os.path.normpath(os.path.join(prefix, "..", "runtime", "bin"))
    if not os.path.isdir(runtime_bin):
        return
    for rel in rel_files:
        if not rel.startswith("bin/"):
            continue
        bname = rel[4:]
        if not bname or "/" in bname:
            continue
        bin_file = os.path.join(prefix, "bin", bname)
        if not (os.path.isfile(bin_file) or os.path.islink(bin_file)):
            continue
        bridge = os.path.join(runtime_bin, bname)
        if os.path.exists(bridge) and not _is_agy_fallback_shim(bridge):
            continue
        body = (
            "#!/system/bin/sh\n"
            f"# AGY bridge -> bionic $PREFIX/bin/{bname}\n"
            f"PREFIX='{prefix}'\n"
            "export PREFIX\n"
            "unset LD_PRELOAD\n"
            'export LD_LIBRARY_PATH="$PREFIX/lib"\n'
            'export PATH="$PREFIX/bin:/system/bin"\n'
            'export GODEBUG="netdns=cgo"\n'
            'export TERM="xterm-256color"\n'
            'export TERMINFO="$PREFIX/share/terminfo"\n'
            'export OPENSSL_CONF="$PREFIX/etc/tls/openssl.cnf"\n'
            'export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"\n'
            'export CURL_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"\n'
            'export GIT_SSL_CAINFO="$PREFIX/etc/tls/cert.pem"\n'
            'export GIT_CONFIG_NOSYSTEM=1\n'
            'export GIT_ATTR_NOSYSTEM=1\n'
            'export GIT_TEMPLATE_DIR="$PREFIX/share/git-core/templates"\n'
            'export GIT_EXEC_PATH="$PREFIX/libexec/git-core"\n'
            'export PAGER="cat"\n'
            f'exec "$PREFIX/bin/{bname}" "$@"\n'
        )
        with open(bridge, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(bridge, 0o755)


def check_free_space(prefix: str, needed_bytes: int) -> Tuple[bool, int, int]:
    st = os.statvfs(prefix if os.path.exists(prefix) else os.path.dirname(prefix))
    avail = st.f_bavail * st.f_frsize
    return avail >= needed_bytes, avail, needed_bytes


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def cmd_plan(args) -> int:
    sync_dpkg_status(args.prefix, args.pkg_db)
    installed = load_installed_db(args.pkg_db)
    best, providers, repo_urls = load_index_map(args.pkg_index)
    if not best:
        print("ERR\tno index (run: pkg update)", file=sys.stderr)
        return 1

    if args.upgrade:
        targets = []
        for name, cur_ver in sorted(installed.items()):
            cand = best.get(name)
            if cand and cand[1][1] and vercmp(cand[1][1], cur_ver) == 1:
                targets.append(name)
        if not targets:
            print("SUMMARY|0|0")
            return 0
        upgrade_set = set(targets)
        ok, order, err = resolve_packages(targets, best, providers, installed, force_upgrade=upgrade_set)
        if not ok:
            print(f"ERR\t{err}", file=sys.stderr)
            return 1
        to_install = [n for n in order if (n in upgrade_set or n not in installed)]
    else:
        already: List[Tuple[str, str]] = []
        need_resolve: List[str] = []
        for name in args.targets:
            if name in installed:
                already.append((name, installed[name] or "unknown"))
                continue
            if name not in best and name not in providers:
                print(f"ERR\tE: Unable to locate package {name}", file=sys.stderr)
                return 1
            need_resolve.append(name)
        for name, cur_ver in already:
            print(f"ALREADY|{name}|{cur_ver}")
        if not need_resolve:
            print("SUMMARY|0|0")
            return 0
        upgrade_set: set = set()
        ok, order, err = resolve_packages(need_resolve, best, providers, installed, force_upgrade=upgrade_set)
        if not ok:
            print(f"ERR\tdependency resolution failed: {err}", file=sys.stderr)
            return 1
        to_install = [n for n in order if (n in upgrade_set or n not in installed)]

    total_archive_bytes = 0
    rows = []
    for n in to_install:
        entry = best.get(n)
        if not entry:
            print(f"ERR\tunknown package: {n}", file=sys.stderr)
            return 1
        base, cols = entry
        fn = cols[8]
        if not fn:
            print(f"ERR\t{n}: no Filename in index", file=sys.stderr)
            return 1
        sz = int(cols[9]) if cols[9].isdigit() else 0
        sha = cols[10]
        repo_base = repo_urls.get(base, "")
        url = f"{repo_base}/{fn}" if repo_base else fn
        cache_path = os.path.join(args.pkg_cache, os.path.basename(fn))
        cached_ok = os.path.isfile(cache_path) and (not sha or sha256_file(cache_path) == sha)
        if not cached_ok:
            total_archive_bytes += sz
        rows.append((
            n,
            cols[1] or "0",
            cols[2] or "aarch64",
            fn,
            url,
            str(sz),
            sha or "-",
            cache_path,
            "1" if cached_ok else "0",
        ))

    # Preflight disk space check (~3x archive margin + 32 MB buffer)
    needed = max(total_archive_bytes * 3 + 32 * 1024 * 1024, 16 * 1024 * 1024)
    ok_space, avail, _ = check_free_space(args.prefix, needed)
    if not ok_space:
        print(
            f"ERR|insufficient disk space in {args.prefix}: need ~{needed // (1024*1024)} MB free, "
            f"have {avail // (1024*1024)} MB",
            file=sys.stderr,
        )
        return 2

    total_all_archives = sum(int(r[5]) for r in rows)
    print(f"SUMMARY|{len(rows)}|{total_all_archives}")
    for r in rows:
        print("PKG|" + "|".join(r))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_vc = sub.add_parser("vercmp")
    p_vc.add_argument("a")
    p_vc.add_argument("b")

    p_sync = sub.add_parser("sync-dpkg")
    p_sync.add_argument("prefix")
    p_sync.add_argument("pkg_db")

    p_idx = sub.add_parser("index-rebuild")
    p_idx.add_argument("pkg_index")
    p_idx.add_argument("--force", action="store_true")

    p_parse = sub.add_parser("index-parse")
    p_parse.add_argument("packages_file")

    p_lookup = sub.add_parser("index-lookup")
    p_lookup.add_argument("pkg_index")
    p_lookup.add_argument("name")

    p_prov = sub.add_parser("index-provider")
    p_prov.add_argument("pkg_index")
    p_prov.add_argument("name")

    p_search = sub.add_parser("search")
    p_search.add_argument("pkg_index")
    p_search.add_argument("pattern", nargs="?", default="")

    p_res = sub.add_parser("resolve")
    p_res.add_argument("pkg_index")
    p_res.add_argument("pkg_db")
    p_res.add_argument("targets", nargs="+")

    p_plan = sub.add_parser("plan")
    p_plan.add_argument("prefix")
    p_plan.add_argument("pkg_index")
    p_plan.add_argument("pkg_db")
    p_plan.add_argument("pkg_cache")
    p_plan.add_argument("--upgrade", action="store_true")
    p_plan.add_argument("targets", nargs="*")

    p_df = sub.add_parser("deb-field")
    p_df.add_argument("deb")
    p_df.add_argument("field")

    p_dm = sub.add_parser("deb-members")
    p_dm.add_argument("deb")

    p_dv = sub.add_parser("deb-validate")
    p_dv.add_argument("deb")

    p_dl = sub.add_parser("deb-files")
    p_dl.add_argument("deb")
    p_dl.add_argument("--strip", type=int, default=6)

    p_dx = sub.add_parser("deb-extract")
    p_dx.add_argument("deb")
    p_dx.add_argument("dest")
    p_dx.add_argument("--strip", type=int, default=6)

    p_si = sub.add_parser("stage-install")
    p_si.add_argument("deb")
    p_si.add_argument("prefix")
    p_si.add_argument("pkg_root")
    p_si.add_argument("pkg_db")
    p_si.add_argument("name")
    p_si.add_argument("version")
    p_si.add_argument("arch")
    p_si.add_argument("--keep-cache", action="store_true")

    p_rw = sub.add_parser("rewrite-prefix")
    p_rw.add_argument("prefix")
    p_rw.add_argument("targets", nargs="*")

    p_sha = sub.add_parser("verify-sha256")
    p_sha.add_argument("pairs", nargs="*")

    args = parser.parse_args()

    if args.cmd == "vercmp":
        print(vercmp(args.a, args.b))
        return 0
    if args.cmd == "sync-dpkg":
        sync_dpkg_status(args.prefix, args.pkg_db)
        return 0
    if args.cmd == "index-rebuild":
        ensure_indexes_fresh(args.pkg_index, force=args.force)
        return 0
    if args.cmd == "index-parse":
        rows = parse_packages_to_tsv(args.packages_file, None)
        if rows:
            print("\n".join(rows))
        return 0
    if args.cmd == "index-lookup":
        best, _, _ = load_index_map(args.pkg_index)
        entry = best.get(args.name)
        if entry:
            print(entry[0] + "\t" + "\t".join(entry[1]))
        return 0
    if args.cmd == "index-provider":
        best, providers, _ = load_index_map(args.pkg_index)
        for p in providers.get(args.name, ()):
            entry = best.get(p)
            if entry:
                print(entry[0] + "\t" + "\t".join(entry[1]))
                break
        return 0
    if args.cmd == "search":
        ensure_indexes_fresh(args.pkg_index)
        try:
            rx = re.compile(args.pattern) if args.pattern else None
        except re.error:
            rx = re.compile(re.escape(args.pattern))
        seen = set()
        out = []
        for fn in sorted(os.listdir(args.pkg_index)):
            if not (fn.startswith("repo.") and fn.endswith(".tsv")):
                continue
            with open(os.path.join(args.pkg_index, fn), "r", encoding="utf-8", errors="replace") as f:
                for raw in f:
                    cols = raw.rstrip("\n").split("\t")
                    if len(cols) >= 2 and (rx is None or rx.search(cols[0])):
                        key = (cols[0], cols[1])
                        if key not in seen:
                            seen.add(key)
                            out.append(key)
        for name, ver in sorted(out):
            print(f"{name:<24} {ver}")
        return 0
    if args.cmd == "resolve":
        installed = load_installed_db(args.pkg_db)
        best, providers, _ = load_index_map(args.pkg_index)
        ok, order, err = resolve_packages(args.targets, best, providers, installed)
        if not ok:
            print(f"pkg: warn: {err}", file=sys.stderr)
            return 1
        if order:
            print("\n".join(order))
        return 0
    if args.cmd == "plan":
        return cmd_plan(args)
    if args.cmd == "stage-install":
        stage_install_deb(
            args.deb,
            args.prefix,
            args.pkg_root,
            args.pkg_db,
            args.name,
            args.version,
            args.arch,
            keep_cache=args.keep_cache,
        )
        return 0
    if args.cmd == "deb-field":
        print(read_control_field(args.deb, args.field))
        return 0
    if args.cmd == "deb-members":
        for name, _, _ in ar_list_members(args.deb):
            print(name)
        return 0
    if args.cmd in ("deb-validate", "deb-files"):
        strip_n = getattr(args, "strip", 6)
        stream, proc, _ = _open_tar_stream_from_ar(args.deb, "data")
        rel_list: List[str] = []
        try:
            with tarfile.open(fileobj=stream, mode="r|*") as tf:
                for member in tf:
                    ok, rel = strip_data_member_path(member.name, strip_n)
                    if not ok:
                        return 1
                    if rel and not member.isdir():
                        rel_list.append(rel)
            if proc is not None and proc.wait() != 0:
                return 1
        except Exception:
            return 1
        if args.cmd == "deb-files":
            for r in sorted(set(rel_list)):
                print(r)
        return 0
    if args.cmd == "deb-extract":
        os.makedirs(args.dest, exist_ok=True)
        stage_tmp = os.path.join(args.dest, f".pkg_stage.{os.getpid()}")
        os.makedirs(stage_tmp, exist_ok=True)
        stream, proc, _ = _open_tar_stream_from_ar(args.deb, "data")
        dir_modes: Dict[str, int] = {}
        try:
            with tarfile.open(fileobj=stream, mode="r|*") as tf:
                for member in tf:
                    ok, rel = strip_data_member_path(member.name, args.strip)
                    if not ok:
                        return 1
                    if not rel:
                        continue
                    dst = os.path.join(stage_tmp, rel)
                    if member.isdir():
                        os.makedirs(dst, exist_ok=True)
                        dir_modes[rel] = member.mode or 0o755
                        continue
                    parent = os.path.dirname(dst)
                    if parent:
                        os.makedirs(parent, exist_ok=True)
                    if member.issym():
                        link = member.linkname
                        if not link or "\x00" in link:
                            return 1
                        if not os.path.isabs(link):
                            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(rel) or ".", link))
                            if resolved == ".." or resolved.startswith("../"):
                                return 1
                        if os.path.lexists(dst):
                            os.unlink(dst)
                        os.symlink(link, dst)
                    elif member.islnk():
                        ok_l, trel = strip_data_member_path(member.linkname, args.strip)
                        if not ok_l or not trel:
                            return 1
                        os.link(os.path.join(stage_tmp, trel), dst)
                    elif member.isreg():
                        fobj = tf.extractfile(member)
                        if fobj is None:
                            return 1
                        with open(dst, "wb") as out:
                            shutil.copyfileobj(fobj, out, 256 * 1024)
                        os.chmod(dst, stat.S_IMODE(member.mode or 0o644) | 0o200)
            if proc is not None and proc.wait() != 0:
                return 1
            _merge_stage_into_prefix(stage_tmp, args.dest, dir_modes)
            return 0
        except Exception:
            return 1
        finally:
            shutil.rmtree(stage_tmp, ignore_errors=True)
    if args.cmd == "rewrite-prefix":
        targets = list(args.targets)
        if not targets and not sys.stdin.isatty():
            targets = [line.rstrip("\n") for line in sys.stdin if line.strip()]
        if not targets:
            targets = [args.prefix]
        files: List[str] = []
        for t in targets:
            if os.path.isfile(t) and not os.path.islink(t):
                files.append(t)
            elif os.path.isdir(t):
                for r, _, fns in os.walk(t):
                    for fn in fns:
                        fp = os.path.join(r, fn)
                        if not os.path.islink(fp):
                            _patch_single_text(fp, args.prefix)
        for fp in files:
            abs_p = fp if os.path.isabs(fp) else os.path.join(args.prefix, fp)
            if os.path.isfile(abs_p) and not os.path.islink(abs_p):
                _patch_single_text(abs_p, args.prefix)
        return 0
    if args.cmd == "verify-sha256":
        for pair in args.pairs:
            path, want = pair.split(":", 1)
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                print(f"FAIL\t{path}")
                continue
            if want and sha256_file(path) != want:
                print(f"BADSHA\t{path}")
                continue
            print(f"OK\t{path}")
        return 0
    return 1


def _patch_single_text(fp: str, prefix: str) -> None:
    try:
        with open(fp, "rb") as f:
            data = f.read()
    except OSError:
        return
    if b"\x00" in data[:8192]:
        return
    if b"/data/data/" in data or b"/data/user/" in data:
        new_data = PREFIX_RE_BYTES.sub(prefix.encode("utf-8"), data)
        if new_data != data:
            _atomic_rewrite_bytes(fp, new_data, os.stat(fp).st_mode)


if __name__ == "__main__":
    raise SystemExit(main())
