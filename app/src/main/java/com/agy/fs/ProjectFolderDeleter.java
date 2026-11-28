package com.agy.fs;

import android.content.Context;
import android.os.Environment;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Safely deletes a local project directory on Android storage with strict
 * allowlist/denylist enforcement and no-follow symlink semantics (Java 8 / API 24).
 */
public final class ProjectFolderDeleter {

    private static final String TAG = "ProjectFolderDeleter";
    private static final Charset UTF_8 = Charset.forName("UTF-8");
    private static final int MAX_DELETE_DEPTH = 128;

    /**
     * Subtrees inside app filesDir that are strictly forbidden (both the directory
     * itself and any descendant inside it).
     */
    private static final Set<String> FORBIDDEN_FILES_SUBTREES = Collections.unmodifiableSet(
            new HashSet<String>(Arrays.asList(
                    ".gemini", ".config", ".local", ".cache", ".tmp", ".ssh", ".npm", ".android",
                    "usr", "runtime", "web", "logs", "etc", "cache", "home", "tmp",
                    "bin", "lib", "share", "var", "opt"
            ))
    );

    /**
     * Container directories directly under filesDir whose root itself must never be
     * deleted, while specific child project folders inside them are allowed.
     */
    private static final Set<String> PROTECTED_FILES_CONTAINERS = Collections.unmodifiableSet(
            new HashSet<String>(Arrays.asList(
                    "projects"
            ))
    );

    /**
     * Top-level shared storage directories under /storage/emulated/0 that must never
     * be deleted as a whole. Specific project subdirectories inside them (except Android/)
     * are allowed.
     */
    private static final Set<String> PROTECTED_EXTERNAL_TOP_LEVEL = Collections.unmodifiableSet(
            new HashSet<String>(Arrays.asList(
                    "documents", "download", "downloads", "dcim", "pictures",
                    "music", "movies", "android", "alarms", "notifications",
                    "ringtones", "podcasts", "audiobooks", "recordings", "lost.dir"
            ))
    );

    private ProjectFolderDeleter() {
    }

    /** Result of validating a candidate project folder path before deletion. */
    public static final class ValidationResult {
        public final boolean ok;
        public final File canonicalDir;
        public final String canonicalPath;
        public final String error;

        private ValidationResult(boolean ok, File canonicalDir, String canonicalPath, String error) {
            this.ok = ok;
            this.canonicalDir = canonicalDir;
            this.canonicalPath = canonicalPath != null ? canonicalPath : "";
            this.error = error != null ? error : "";
        }

        static ValidationResult success(File dir, String path) {
            return new ValidationResult(true, dir, path, "");
        }

        static ValidationResult failure(String path, String error) {
            return new ValidationResult(false, null, path, error);
        }
    }

    /**
     * Validates that {@code rawPath} points to an existing, non-symlink local directory
     * strictly inside an allowed project root and not matching any protected system path.
     */
    public static ValidationResult validateTarget(Context context, String rawPath) {
        if (context == null) {
            return ValidationResult.failure("", "Missing application context");
        }
        String normalized = normalizeLocalPath(rawPath);
        if (normalized == null) {
            return ValidationResult.failure("", "Invalid or non-local project path");
        }

        File rawFile = new File(normalized);
        if (isSymlink(rawFile)) {
            return ValidationResult.failure(normalized, "Refusing to delete symbolic link");
        }
        if (!rawFile.exists()) {
            return ValidationResult.failure(normalized, "Project folder does not exist");
        }
        if (!rawFile.isDirectory()) {
            return ValidationResult.failure(normalized, "Target path is not a directory");
        }

        final File canonicalDir;
        final String canonicalPath;
        try {
            canonicalDir = rawFile.getCanonicalFile();
            canonicalPath = canonicalDir.getPath();
        } catch (IOException e) {
            return ValidationResult.failure(normalized, "Failed to canonicalize path");
        }

        if (!canonicalDir.exists() || !canonicalDir.isDirectory()) {
            return ValidationResult.failure(canonicalPath, "Canonical target is not an existing directory");
        }
        if (isSymlink(canonicalDir)) {
            return ValidationResult.failure(canonicalPath, "Refusing to delete symbolic link");
        }

        if (isAllowedInFilesDir(context, canonicalPath)) {
            return ValidationResult.success(canonicalDir, canonicalPath);
        }
        if (isAllowedInExternalStorage(canonicalPath)) {
            return ValidationResult.success(canonicalDir, canonicalPath);
        }
        return ValidationResult.failure(canonicalPath, "Refusing to delete protected or out-of-scope directory");
    }

    /**
     * Synchronously validates and deletes a project folder, returning a JSON payload
     * {@code {"ok": boolean, "path": string, "error": string}}.
     */
    public static String deleteProjectFolder(Context context, String rawPath) {
        ValidationResult validation = validateTarget(context, rawPath);
        if (!validation.ok) {
            return buildJson(false, validation.canonicalPath, validation.error);
        }
        return deleteValidatedDirectory(validation.canonicalDir, validation.canonicalPath);
    }

    /**
     * Deletes a previously validated canonical directory recursively without following
     * symbolic links.
     */
    public static String deleteValidatedDirectory(File canonicalDir, String canonicalPath) {
        if (canonicalDir == null) {
            return buildJson(false, canonicalPath, "Missing target directory");
        }
        try {
            boolean deleted = deleteRecursivelyNoFollow(canonicalDir, 0);
            if (!deleted && canonicalDir.exists()) {
                return buildJson(false, canonicalPath, "Failed to delete project folder completely");
            }
            return buildJson(true, canonicalPath, "");
        } catch (Throwable t) {
            Log.e(TAG, "Error deleting project folder: " + canonicalPath, t);
            return buildJson(false, canonicalPath, "Error deleting project folder: " + t.getMessage());
        }
    }

    /** Builds a consistent JSON response string {@code {ok, path, error}}. */
    public static String buildJson(boolean ok, String path, String error) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("ok", ok);
            obj.put("path", path != null ? path : "");
            obj.put("error", error != null ? error : "");
        } catch (Exception ignored) {
            return "{\"ok\":false,\"path\":\"\",\"error\":\"JSON serialization error\"}";
        }
        return obj.toString();
    }

    /**
     * Converts a {@code file://} URI or absolute filesystem path into a decoded absolute
     * path, or returns {@code null} for remote/invalid inputs.
     */
    static String normalizeLocalPath(String rawPath) {
        if (rawPath == null) {
            return null;
        }
        String s = rawPath.trim();
        if (s.isEmpty() || s.indexOf('\0') >= 0) {
            return null;
        }

        int schemeIdx = s.indexOf("://");
        if (schemeIdx >= 0) {
            String scheme = s.substring(0, schemeIdx).toLowerCase(Locale.US);
            if (!"file".equals(scheme)) {
                return null;
            }
            s = s.substring(schemeIdx + 3);
            if (s.regionMatches(true, 0, "localhost/", 0, 10)) {
                s = s.substring(9);
            }
            if (!s.startsWith("/")) {
                return null;
            }
            int q = s.indexOf('?');
            if (q >= 0) {
                s = s.substring(0, q);
            }
            int hash = s.indexOf('#');
            if (hash >= 0) {
                s = s.substring(0, hash);
            }
            s = decodePercentUtf8(s);
            if (s == null || s.indexOf('\0') >= 0) {
                return null;
            }
        }

        if (!s.startsWith("/")) {
            return null;
        }
        // Collapse trailing slashes (except root "/")
        while (s.length() > 1 && s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    /**
     * Decodes UTF-8 percent-encoded sequences (%XX) without altering literal '+' characters.
     */
    private static String decodePercentUtf8(String input) {
        if (input.indexOf('%') < 0) {
            return input;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(input.length());
        int len = input.length();
        for (int i = 0; i < len; i++) {
            char c = input.charAt(i);
            if (c == '%') {
                if (i + 2 >= len) {
                    return null;
                }
                int hi = Character.digit(input.charAt(i + 1), 16);
                int lo = Character.digit(input.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) {
                    return null;
                }
                out.write((hi << 4) | lo);
                i += 2;
            } else if (c < 0x80) {
                out.write(c);
            } else {
                byte[] bytes = String.valueOf(c).getBytes(UTF_8);
                out.write(bytes, 0, bytes.length);
            }
        }
        return new String(out.toByteArray(), UTF_8);
    }

    private static boolean isAllowedInFilesDir(Context context, String canonicalPath) {
        File filesDir = context.getFilesDir();
        if (filesDir == null) {
            return false;
        }
        String rootPath;
        try {
            rootPath = filesDir.getCanonicalPath();
        } catch (IOException e) {
            return false;
        }
        String prefix = rootPath.endsWith("/") ? rootPath : (rootPath + "/");
        if (!canonicalPath.startsWith(prefix)) {
            return false;
        }
        String rel = canonicalPath.substring(prefix.length());
        if (rel.isEmpty()) {
            return false;
        }
        String[] segments = rel.split("/");
        if (segments.length == 0 || segments[0].isEmpty()) {
            return false;
        }
        String first = segments[0];
        String firstLower = first.toLowerCase(Locale.US);
        // Refuse all hidden dot directories and forbidden app/system subtrees.
        if (first.startsWith(".") || FORBIDDEN_FILES_SUBTREES.contains(firstLower)) {
            return false;
        }
        // Refuse container roots like filesDir/projects itself, but allow filesDir/projects/<name>.
        if (PROTECTED_FILES_CONTAINERS.contains(firstLower) && segments.length < 2) {
            return false;
        }
        return true;
    }

    private static boolean isAllowedInExternalStorage(String canonicalPath) {
        String[] candidates = getExternalRootPaths();
        for (int i = 0; i < candidates.length; i++) {
            String rootPath = candidates[i];
            if (rootPath == null || rootPath.isEmpty()) {
                continue;
            }
            String prefix = rootPath.endsWith("/") ? rootPath : (rootPath + "/");
            if (!canonicalPath.startsWith(prefix)) {
                continue;
            }
            String rel = canonicalPath.substring(prefix.length());
            if (rel.isEmpty()) {
                return false;
            }
            String[] segments = rel.split("/");
            if (segments.length == 0 || segments[0].isEmpty()) {
                return false;
            }
            String first = segments[0];
            String firstLower = first.toLowerCase(Locale.US);
            // Strictly refuse hidden top-level folders and anything under Android/.
            if (first.startsWith(".") || "android".equals(firstLower)) {
                return false;
            }
            // Refuse top-level shared system roots (e.g. /storage/emulated/0/Documents itself),
            // while allowing specific project folders inside them (e.g. Documents/my-project).
            if (segments.length == 1 && PROTECTED_EXTERNAL_TOP_LEVEL.contains(firstLower)) {
                return false;
            }
            return true;
        }
        return false;
    }

    private static String[] getExternalRootPaths() {
        String extDir = null;
        try {
            File dir = Environment.getExternalStorageDirectory();
            if (dir != null) {
                extDir = dir.getCanonicalPath();
            }
        } catch (Throwable ignored) {
        }
        String emulated = "/storage/emulated/0";
        try {
            emulated = new File(emulated).getCanonicalPath();
        } catch (Throwable ignored) {
        }
        if (extDir != null && !extDir.equals(emulated)) {
            return new String[]{extDir, emulated};
        }
        return new String[]{emulated};
    }

    /**
     * Checks whether {@code file} is a POSIX symbolic link without following it.
     * Uses {@link Os#lstat(String)} (API 21+) with a canonical-path fallback.
     */
    static boolean isSymlink(File file) {
        if (file == null) {
            return false;
        }
        try {
            StructStat st = Os.lstat(file.getAbsolutePath());
            if (st != null) {
                return OsConstants.S_ISLNK(st.st_mode);
            }
        } catch (Throwable ignored) {
            // Fall through to canonical-path heuristic if Os.lstat is unavailable.
        }
        try {
            File parent = file.getParentFile();
            File canonParent = parent != null ? parent.getCanonicalFile() : null;
            File expected = canonParent != null ? new File(canonParent, file.getName()) : file;
            return !expected.getCanonicalFile().equals(expected.getAbsoluteFile());
        } catch (IOException ignored) {
            return false;
        }
    }

    private static boolean deleteRecursivelyNoFollow(File node, int depth) {
        if (node == null || depth > MAX_DELETE_DEPTH) {
            return false;
        }
        if (isSymlink(node)) {
            return node.delete();
        }
        if (node.isDirectory()) {
            File[] children = node.listFiles();
            if (children != null) {
                for (int i = 0; i < children.length; i++) {
                    if (!deleteRecursivelyNoFollow(children[i], depth + 1)) {
                        return false;
                    }
                }
            }
        }
        return node.delete();
    }
}
