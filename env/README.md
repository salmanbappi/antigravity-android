# Antigravity Environment Architecture & Audit (`env/`)

> [!NOTE]
> Technical specification for the `env/` Bionic rootfs in Antigravity (AGY v2), covering the userspace layout, accelerated `pkg` package manager, dynamic Android/Termux path rewriting, ARMv8.1-A+ (`liblse_compat`) compatibility, and build/verification commands.

---

## 1. Rootfs Structure (`env/`)

`env/` provides a self-contained ARM64 (`aarch64`) Bionic Linux userspace running inside the Android application sandbox without root privileges, `proot`, or `ptrace` syscall interception.

```text
env/
├── README.md                 # Architecture & pkg specification (this file)
├── README                    # Legacy prefix-rewriting notes
├── seed-packages.txt         # Default first-launch Termux seed packages (nodejs-lts)
├── build.sh                  # Stages bootstrap, overlay, and pkg into dist/env/
├── bootstrap/                # Base Termux bootstrap & repackaging scripts
│   ├── bootstrap-aarch64.zip # Upstream Termux bootstrap archive
│   ├── bootstrap.tar.gz      # Optimized tarball (symlinks & pruned docs)
│   └── patch-prefix.py       # (Legacy) binary prefix patcher for dpkg
├── packages/                 # Pre-bundled extra .deb archives
│   └── git.deb               # Bundled Git package for offline autonomous workflows
├── overlay/                  # Files overlaid onto $PREFIX (etc, bin, lib)
│   ├── bin/                  # System CLI scripts & utilities
│   │   ├── agy-daemon        # Background scheduler/watcher (fcntl.flock on daemon.lock)
│   │   ├── agy-fix-paths     # Shebang & path normalizer for pip/npm global scripts
│   │   ├── agy-notify        # Android status notification helper
│   │   ├── agy-root          # Root wrapper (uid=0) for KernelSU/bakaSU/Magisk/APatch (-mm)
│   │   ├── agy-sys           # Root diagnostics, Doze/OOM protection, pm, and logcat helper
│   │   ├── agy-upgrade       # Safe environment upgrade, backup, and migration CLI
│   │   ├── rish              # Shizuku elevated shell client (uid=2000)
│   │   ├── su                # KernelSU/bakaSU/Magisk/APatch-compatible su wrapper
│   │   ├── sudo              # sudo frontend backed by agy-root
│   │   └── cs                # Helper stub for language_server
│   ├── etc/                  # Default configuration files
│   │   ├── antigravity/      # Global agent rules
│   │   ├── pkg/repo.conf     # Package mirror list (packages-cf/termux/bfsu, tuna last fallback)
│   │   ├── profile.d/        # Shell startup hooks (00-env.sh)
│   │   ├── tls/              # CA bundle cert.pem and openssl.cnf
│   │   ├── hosts             # Loopback hosts table
│   │   ├── motd              # Terminal banner
│   │   ├── profile           # Root bash profile
│   │   └── resolv.conf       # Public DNS servers (1.1.1.1, 8.8.8.8)
│   └── lib/                  # Userspace shared libraries & daemon modules
│       ├── libtermux-exec.so # execve interceptor translating legacy Termux paths
│       └── daemon/           # Python modules powering agy-daemon
├── pkg/                      # Built-in package manager (pkg_core.py + Bash/AWK fallback)
│   ├── pkg                   # CLI entrypoint
│   └── lib/                  # Modular pkg libraries
│       ├── pkg_core.py       # Unified Python engine (-B): mtime-cached db/index, DFS/upgrade plan, stage-install, ELF patch
│       ├── util.sh           # Env setup, logging, rewrite_prefix
│       ├── deb.sh            # ar/.deb reader & validator (delegates to pkg_core.py with dd/tar fallback)
│       ├── db.sh             # Local installed metadata database (.meta, .files)
│       ├── fetch.sh          # Parallel curl -Z --http2 downloader w/ per-file mirror fallback & SHA256
│       ├── index.sh          # Package index parsing & TSV generation
│       ├── index.awk         # AWK fallback stanza parser
│       ├── resolver.sh       # Dependency graph & cycle detection
│       ├── version.sh        # Debian version comparator
│       └── vercmp.awk        # Pure-AWK Debian vercmp fallback
├── liblse_compat/            # ARMv8.1-A+ LSE/SIMD SIGILL software emulator
│   ├── liblse_compat.c       # SIGILL trap & instruction decoder
│   ├── liblse_compat.so      # Compiled Glibc preload shared library
│   └── build.sh              # Build script
├── repo/                     # Local repo cache (empty by default)
├── scripts/                  # Build & manifest utilities
│   ├── pack_bootstrap.py     # Repacks zip -> tar.gz with pruned docs & extra debs
│   └── make_manifest.py      # Deterministic SHA-256 manifest.json generator
├── dist/                     # Staged assets packaged into APK assets/env
│   └── env/                  # Final mirror (bootstrap, overlay, pkg, manifest.json)
└── tests/                    # Automated test suite
    ├── fixtures/             # Test fixtures (hello.deb, Packages)
    ├── selftest              # Offline pkg & helper unit tests
    ├── invariant             # 1:1 asset & symlink parity verification
    └── e3                    # End-to-end prefix bootstrap & live pkg install test
```

### Android Sandbox Paths
Extracted by `com.agy.install.EnvInstaller`:
- **`$HOME`**: `/data/user/<id>/<package_id>/files`
- **`$PREFIX`**: `$HOME/usr`
- **`$PREFIX/bin`**, **`$PREFIX/lib`**, **`$PREFIX/etc`** (including `etc/tls/cert.pem`), **`$PREFIX/libexec/pkg`**, **`$PREFIX/var/lib/pkg`** (`installed/`, `cache/`, `index/`).

---

## 2. `pkg` Package Manager Architecture

`pkg` requires no `apt` or `dpkg` processes at install time: when embedded `python3` is available, hot paths run through `pkg_core.py` (invoked with `-B` and `sys.dont_write_bytecode = True` so no `__pycache__` files are emitted), while clean POSIX Bash/AWK fallbacks remain intact.

### Commands
| Command | Description |
| :--- | :--- |
| `pkg update` | Fetches `Packages.gz` conditionally via `curl -z` (skipping unchanged timestamps) and updates mtime-cached TSV indexes. |
| `pkg install [--keep-cache] <pkg...>` | Runs free-space preflight check and DFS `plan`, fetches missing `.deb`s in parallel (`curl -Z --http2`) with per-file SHA-256 + mirror fallback, validates & stages each `.deb` atomically (rewriting text & length-preserving ELF paths), updates DB + `runtime/bin` bridges, and cleans cached `.deb`s unless `--keep-cache` is passed. |
| `pkg upgrade [--keep-cache]` | Resolves outdated installed packages alongside newly added transitive dependencies through `pkg_core.py plan --upgrade`, then downloads and stages atomically. |
| `pkg remove <pkg...>` | Removes tracked `.files`, prunes empty parent dirs, and clears `.meta`. |
| `pkg list [regex]` / `pkg search <regex>` | Queries package indexes via `pkg_core.py search` (or AWK fallback). |
| `pkg installed` / `pkg info <pkg>` / `pkg why <file>` | Lists installed packages, prints stanza fields, and reverses `.files` ownership. |
| `pkg clean` / `pkg selftest` | Purges `$PKG_CACHE/*.deb` or runs offline environment health checks. |

### Safe Single-Pass `.deb` Staging (`stage_install_deb`)
- Streams `data.tar.*` via `dpkg-deb --fsys-tarfile` (or pure-Python `ar`/`gzip`/`lzma` fallback) into a private directory `$PKG_ROOT/tmp/stage.<pid>.<pkg>`.
- Explicitly strips normalized `data/(data|user/[0-9]+)/<pkg>/files/usr/` prefixes (robust both with and without leading `./`, plus directory symlinks).
- Rejects absolute paths, `..`, backslashes, NUL bytes, and escaping relative symlinks *before* modifying `$PREFIX`.
- Rewrites text interpreter/config paths to `$PREFIX` and patches ELF `/data/data/com.termux` / `/data/user/0/com.termux` references only when `len(pkg_id) <= 10` using exact `/` padding (e.g. `com.agy///`), safely skipping longer package IDs like `com.agy.dev` without corrupting binaries.

---

## 3. Dynamic Path Translation & ARMv8.0-A Compatibility (`liblse_compat`)

1. **Three-Layer Termux Path Adaptation:**
   - **Install-Time (Java):** `TermuxShebangRewriter`, `TermuxPrefixRewriter`, `TermuxSymlinkFixer` normalize bootstrap/config files under `bin`, `libexec`, `etc`, `share`, and `var`.
   - **Runtime (`LD_PRELOAD`):** `libtermux-exec.so` intercepts `execve`/`execvp` to remap `/bin/sh` and Termux paths to `$PREFIX`.
   - **Post-Install (`pkg` / `agy-fix-paths`):** `stage_install_deb` / `rewrite_prefix` and `agy-fix-paths` rewrite installed and `pip`/`npm` text scripts idempotently.
2. **ARMv8.1-A+ LSE & SIMD Emulation (`liblse_compat.so`):**
   - Compiled against **GNU Glibc** solely for the `language_server` core loaded via `libloader.so --preload` (`RuntimeManager.java`). Must **never** be added to Bionic `LD_PRELOAD` (Bionic lacks `libc.so.6`).
   - Registers a kernel-level `SIGILL` handler via direct syscall `rt_sigaction(134)` and hooks `sigaction` so guest runtimes (Go/JVM) do not clobber it, emulating `FEAT_LSE` (`LDADD`/`SWP`/`CAS`), `FEAT_LRCPC`/`LRCPC2` (`LDAPR`/`STLUR`), `FEAT_DotProd` (`SDOT`/`UDOT`), `FEAT_RDM`, and `FEAT_FCMA`.

---

## 4. Audit Fixes & Improvements

1. **`pkg` Performance & Safety [RESOLVED - Batch B]:** Replaced Bash `dd` `ar` loops, 4-pass `deb.sh` extraction, slow AWK `db_sync_dpkg`, recursive `resolver.sh` subshells, and hung `tuna` primary timeouts with `pkg_core.py`, parallel `curl -Z --http2` + per-file mirror fallback, `curl -z`, mtime caching, and `stage_install_deb`.
2. **`agy-notify` & `agy-upgrade` Paths [RESOLVED]:** Removed developer-specific hardcoded logo path in `agy-notify` and fixed `$HOME` calculation (`dirname "$PREFIX"`) in `agy-upgrade`.
3. **Selective `runtime/bin` Bridge Generation & Fallback Replacement [RESOLVED]:** `pkg` generates clean Bionic bridges (`unset LD_PRELOAD`) only for binaries installed by the current package rather than rescanning all of `$PREFIX/bin/*`, overwriting `# AGY fallback` shims while preserving non-fallback bridges.
4. **Seed Packages (`seed-packages.txt`):** `env/seed-packages.txt` declares `nodejs-lts` (powering built-in Node.js sidecars such as Swarm); `env/build.sh` copies it into `dist/env/` and `make_manifest.py` hashes it into `manifest.json`'s `seedPackages` field.
5. **`agy-daemon` Locking, Adaptive Sleep & Log Rotation [RESOLVED]:** Uses persistent `fcntl.flock` on `daemon.lock` with PID verification, eliminates duplicate lines in `daemon.log`, rotates `daemon.log` at 512 KB, caches `tasks.json` by `stat` (`st_mtime_ns`/`st_size`), and adapts loop sleep up to 30 s when idle.
6. **Remaining Backlog:** Unify `liblse_compat` into `env/build.sh all` and consider sharing prefix-rewrite specs across Java/Python/Bash.

---

## 5. Build & Testing

```bash
# 1. Repack bootstrap tarball:
./env/build.sh bootstrap

# 2. Stage assets into dist/env/ with deterministic manifest.json:
./env/build.sh assets

# 3. Verify asset parity, symlinks, offline pkg suite, and E2E deployment:
bash env/tests/invariant
bash env/tests/selftest
bash env/tests/e3
```
