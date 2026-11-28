package com.agy.runtime;

import android.content.Context;
import android.util.Log;

import com.agy.install.EnvInstaller;
import com.agy.util.AssetUnpacker;
import com.agy.util.FileModeUtil;

import java.io.File;
import java.io.IOException;

/** Phase 1: extract + verify the core runtime and the web UI (fail-closed). */
public final class CoreInstaller {

    private static final String TAG = "CoreInstaller";

    private CoreInstaller() {
    }

    public static void installCore(RuntimeManager rm) {
        Context ctx = rm.appContext();
        File runtimeDir = rm.getRuntimeDir();
        String manifestHash = getAssetManifestHash(ctx);
        String expectedHash = (manifestHash != null ? manifestHash : "") + ":" + getApkVersionToken(ctx);
        boolean upToDate = isRuntimeUpToDate(rm, expectedHash);

        if (!upToDate) {
            Log.i(TAG, "extracting assets/runtime (first launch or runtime update)");
            try {
                wipe(rm, runtimeDir);
                AssetUnpacker.unpackTree(ctx.getAssets(), RuntimePaths.RUNTIME_ASSET, runtimeDir);
            } catch (IOException e) {
                throw new IllegalStateException(
                        "cannot unpack assets/runtime into " + runtimeDir
                                + ": " + e.getMessage(), e);
            }
            FileModeUtil.recursiveSetReadableExecutable(rm.getBinDir());
            FileModeUtil.recursiveSetReadableExecutable(rm.getLibDir());
            String manifestError = ManifestVerifier.verifyError(ctx, runtimeDir);
            if (manifestError != null) {
                throw new IllegalStateException(
                        "runtime integrity check failed: " + manifestError);
            }
            writeMarker(rm.getRuntimeDir(), RuntimePaths.RUNTIME_MARKER, expectedHash);
        } else {
            Log.i(TAG, "runtime up to date (manifest hash matched); skipping extract");
        }
        if (!isWebExtracted(rm)) {
            try {
                AssetUnpacker.unpackTree(ctx.getAssets(), RuntimePaths.WEB_ASSET, rm.getWebDir());
                writeMarker(rm.getWebDir(), RuntimePaths.WEB_MARKER);
            } catch (IOException e) {
                throw new IllegalStateException(
                        "cannot unpack assets/web into " + rm.getWebDir()
                                + ": " + e.getMessage(), e);
            }
        }
        // Exec bits are set once at extraction (and on every generated bridge), so
        // no recursive chmod is needed on a warm launch.
        rm.writeNetworkConfig();
        rm.startNetworkMonitor();
        OnboardingSeeder.seed(ctx, rm.getAppDataDir(), rm.getProjectsDir());
        // Sync builtin plugin overrides (Swarm) and seed bundled local plugins (GitHub)
        syncBuiltinPlugins(rm);
        // Always ensure fallback shells and open-url shims are installed
        // in runtime/bin immediately regardless of whether the bionic prefix is extracted.
        ShellBridgeInstaller.installFallbackBridges(rm.getBinDir(), ctx);
        ShellBridgeInstaller.installOpenUrlShims(rm.getBinDir(), ctx);
        // If the env prefix survived a previous launch, its bridges are cheap to
        // (re)write now. A fresh env install rewrites them when it finishes.
        if (EnvInstaller.isInstalled(ctx)) {
            File prefix = EnvInstaller.prefix(ctx);
            File prefixBash = new File(prefix, com.agy.install.EnvPaths.BASH_REL);
            if (prefixBash.isFile()) {
                com.agy.install.TermuxPrefixRewriter.patchBashBinary(prefixBash);
            }
            com.agy.install.TermuxPrefixRewriter.patchElfBinaries(prefix, prefix.getAbsolutePath());
            ShellBridgeInstaller.install(rm);
        }
    }

    /**
     * Syncs bundled plugins from {@code assets/plugins}:
     * <ul>
     *   <li>Compile-time registered builtin overrides (currently {@code swarm}) are synced
     *       into {@code <appDataDir>/builtin/plugins/<name>} on every call so Android patches
     *       persist after {@code language_server} unpacks {@code builtin/.checksum}.</li>
     *   <li>All other bundled local plugins (such as {@code github}) are seeded into
     *       {@code <geminiDir>/config/plugins/<name>}, which {@code language_server} scans for
     *       both plugin discovery and {@code auth.json} providers. Seeding is gated by
     *       {@code .bundled_version} so fresh installs and APK upgrades install/update the
     *       bundle without resurrecting a plugin the user explicitly uninstalled on the same
     *       APK version, and without modifying {@code config.json} or
     *       {@code plugin-secrets.json}. Any stale copy left under
     *       {@code <appDataDir>/builtin/plugins/<name>} is removed.</li>
     * </ul>
     */
    public static synchronized void syncBuiltinPlugins(RuntimeManager rm) {
        Context ctx = rm.appContext();
        try {
            String[] pluginAssets = ctx.getAssets().list("plugins");
            if (pluginAssets == null || pluginAssets.length == 0) {
                return;
            }
            File builtinPluginsDir = new File(rm.getAppDataDir(), "builtin/plugins");
            File configPluginsDir = rm.getConfigPluginsDir();
            String apkVersionToken = getApkVersionToken(ctx);
            boolean bundledUpToDate = isBundledPluginsUpToDate(configPluginsDir, apkVersionToken);
            boolean seededAnyBundled = false;

            for (String name : pluginAssets) {
                String assetPath = "plugins/" + name;
                String[] children = ctx.getAssets().list(assetPath);
                if (children == null || children.length == 0) {
                    continue;
                }
                if (isBuiltinPluginOverride(name)) {
                    AssetUnpacker.copyTree(
                            ctx.getAssets(), assetPath, new File(builtinPluginsDir, name));
                    Log.i(TAG, "synced builtin plugin override into "
                            + new File(builtinPluginsDir, name));
                } else {
                    deleteStaleBuiltinPluginDir(
                            builtinPluginsDir, new File(builtinPluginsDir, name));
                    if (!bundledUpToDate) {
                        AssetUnpacker.copyTree(
                                ctx.getAssets(), assetPath, new File(configPluginsDir, name));
                        seededAnyBundled = true;
                        Log.i(TAG, "seeded bundled local plugin into "
                                + new File(configPluginsDir, name));
                    }
                }
            }
            if (!bundledUpToDate && seededAnyBundled) {
                writeMarker(configPluginsDir, RuntimePaths.BUNDLED_PLUGINS_MARKER, apkVersionToken);
            }
        } catch (Exception e) {
            Log.w(TAG, "cannot sync bundled plugins: " + e.getMessage());
        }
    }

    private static boolean isBuiltinPluginOverride(String pluginName) {
        return "swarm".equals(pluginName);
    }

    private static String getApkVersionToken(Context ctx) {
        long lastUpdate = 0;
        try {
            lastUpdate = ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime;
        } catch (Exception ignored) {
        }
        return com.agy.BuildConfig.APP_VERSION_CODE + ":" + lastUpdate;
    }

    private static boolean isBundledPluginsUpToDate(File configPluginsDir, String expectedToken) {
        if (expectedToken == null || expectedToken.isEmpty()) {
            return false;
        }
        File marker = new File(configPluginsDir, RuntimePaths.BUNDLED_PLUGINS_MARKER);
        if (!marker.isFile()) {
            return false;
        }
        try (java.io.InputStream in = new java.io.FileInputStream(marker)) {
            String actual = com.agy.util.IoUtil.readAll(in, "UTF-8").trim();
            return expectedToken.equals(actual);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Removes a stale non-builtin plugin directory previously unpacked into
     * {@code <appDataDir>/builtin/plugins/<name>}. Strictly scoped to children of
     * {@code builtinPluginsDir}.
     */
    private static void deleteStaleBuiltinPluginDir(File builtinPluginsDir, File target) {
        if (!target.exists()) {
            return;
        }
        try {
            String rootPath = builtinPluginsDir.getCanonicalPath();
            String targetPath = target.getCanonicalPath();
            if (!targetPath.startsWith(rootPath + File.separator)) {
                Log.w(TAG, "refusing to delete outside builtin/plugins: " + target);
                return;
            }
            deleteRecursive(target);
            Log.i(TAG, "removed stale non-builtin plugin copy: " + target);
        } catch (Exception e) {
            Log.w(TAG, "cannot remove stale builtin plugin dir " + target + ": " + e.getMessage());
        }
    }

    private static void deleteRecursive(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        if (!file.delete()) {
            Log.w(TAG, "could not delete stale path: " + file);
        }
    }

    private static boolean isRuntimeUpToDate(RuntimeManager rm, String expectedHash) {
        if (expectedHash == null || expectedHash.isEmpty()) {
            return false;
        }
        File marker = new File(rm.getRuntimeDir(), RuntimePaths.RUNTIME_MARKER);
        File core = new File(rm.getBinDir(), RuntimePaths.CORE_NAME);
        File loader = new File(rm.getBinDir(), RuntimePaths.LOADER_NAME);
        File lseCompat = new File(rm.getLibDir(), "liblse_compat.so");
        if (!marker.isFile() || !core.isFile() || !loader.isFile() || !lseCompat.isFile()) {
            return false;
        }
        try {
            String actual = com.agy.util.IoUtil.readAll(new java.io.FileInputStream(marker), "UTF-8").trim();
            return expectedHash.equals(actual);
        } catch (Exception e) {
            return false;
        }
    }

    private static String getAssetManifestHash(Context ctx) {
        try (java.io.InputStream in = ctx.getAssets().open(RuntimePaths.MANIFEST_ASSET)) {
            return com.agy.util.Sha256.of(in);
        } catch (Exception e) {
            Log.w(TAG, "cannot hash asset manifest: " + e.getMessage());
            return "";
        }
    }

    private static boolean isWebExtracted(RuntimeManager rm) {
        File marker = new File(rm.getWebDir(), RuntimePaths.WEB_MARKER);
        if (!marker.isFile() || !new File(rm.getWebDir(), "main.js").isFile()) {
            return false;
        }
        try {
            long lastUpdate = rm.appContext().getPackageManager()
                    .getPackageInfo(rm.appContext().getPackageName(), 0).lastUpdateTime;
            if (marker.lastModified() < lastUpdate) {
                Log.i(TAG, "APK updated; refreshing assets/web");
                return false;
            }
        } catch (Exception ignored) {
        }
        return true;
    }

    private static void writeMarker(File dir, String name) {
        writeMarker(dir, name, "1");
    }

    private static void writeMarker(File dir, String name, String content) {
        try {
            com.agy.util.AtomicFileWriter.writeText(new File(dir, name), content + "\n");
        } catch (Exception e) {
            Log.w(TAG, "cannot write marker " + name + ": " + e.getMessage());
        }
    }

    private static void wipe(RuntimeManager rm, File dir) throws IOException {
        assertSafeToWipe(rm, dir);
        if (!dir.exists()) {
            return;
        }
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                wipe(rm, child);
            }
        }
        if (!dir.delete()) {
            throw new IOException("cannot delete " + dir);
        }
    }

    /**
     * Hard safety net: only regenerable state may be wiped. Refuses the app
     * files dir itself, the {@code $HOME/.gemini} user data, any ancestor of it,
     * and anything outside {@code getFilesDir()}.
     */
    private static void assertSafeToWipe(RuntimeManager rm, File dir) throws IOException {
        File files = rm.appContext().getFilesDir();
        String filesPath = files.getCanonicalPath();
        String geminiPath = new File(files, RuntimePaths.GEMINI_DIR).getCanonicalPath();
        String target = dir.getCanonicalPath();
        if (!target.startsWith(filesPath + File.separator)) {
            throw new IOException("refusing to wipe outside filesDir: " + dir);
        }
        if (target.equals(geminiPath)
                || target.startsWith(geminiPath + File.separator)
                || geminiPath.startsWith(target + File.separator)) {
            throw new IOException("refusing to wipe user data under .gemini: " + dir);
        }
    }
}
