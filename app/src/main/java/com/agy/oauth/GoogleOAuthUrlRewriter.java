package com.agy.oauth;

import android.net.Uri;

import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Ensures Google OAuth 2.0 authorize URLs ({@code https://accounts.google.com/o/oauth2/.../auth})
 * always show the full multi-account chooser in the external browser instead of auto-selecting
 * a single signed-in Google account.
 *
 * <p>Operates on the raw query string so existing parameter encodings ({@code redirect_uri},
 * {@code state}, {@code code_challenge}, {@code scope}, {@code client_id}, etc.) are preserved
 * byte-for-byte.
 */
public final class GoogleOAuthUrlRewriter {

    private GoogleOAuthUrlRewriter() {
    }

    /**
     * Rewrites {@code url} if and only if it is an {@code https://accounts.google.com/o/oauth2/.../auth}
     * authorize URL with a non-empty query string:
     * <ul>
     *   <li>Strips {@code login_hint} and {@code authuser} parameters (case-insensitive).</li>
     *   <li>Ensures {@code prompt} includes {@code select_account} (producing
     *       {@code select_account%20consent} if {@code consent} was present, or
     *       {@code select_account} otherwise, and removing {@code none} which is
     *       mutually exclusive with {@code select_account}).</li>
     *   <li>Preserves all other query parameters, their exact percent-encoding, and any
     *       URL fragment verbatim.</li>
     * </ul>
     * Non-matching or malformed URLs are returned unchanged.
     */
    public static String ensureAccountChooser(String url) {
        if (url == null) {
            return null;
        }
        String trimmed = url.trim();
        if (trimmed.isEmpty()) {
            return url;
        }

        Uri uri;
        try {
            uri = Uri.parse(trimmed);
        } catch (Exception e) {
            return url;
        }

        String scheme = uri.getScheme();
        String host = uri.getHost();
        String path = uri.getPath();
        if (scheme == null || !"https".equalsIgnoreCase(scheme)
                || host == null || !"accounts.google.com".equalsIgnoreCase(host)
                || !isOAuthAuthorizePath(path)) {
            return url;
        }

        int hashIdx = trimmed.indexOf('#');
        String beforeFragment = (hashIdx >= 0) ? trimmed.substring(0, hashIdx) : trimmed;
        String fragment = (hashIdx >= 0) ? trimmed.substring(hashIdx) : "";

        int qIdx = beforeFragment.indexOf('?');
        if (qIdx < 0 || qIdx == beforeFragment.length() - 1) {
            return url;
        }

        String base = beforeFragment.substring(0, qIdx);
        String rawQuery = beforeFragment.substring(qIdx + 1);

        String[] rawPairs = rawQuery.split("&", -1);
        List<String> outPairs = new ArrayList<String>(rawPairs.length + 1);
        int promptSlotIndex = -1;
        List<String> extraPromptTokens = new ArrayList<String>();

        for (int i = 0; i < rawPairs.length; i++) {
            String pair = rawPairs[i];
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String rawKey = (eq >= 0) ? pair.substring(0, eq) : pair;
            String rawVal = (eq >= 0) ? pair.substring(eq + 1) : "";
            String lowerKey = rawKey.toLowerCase(Locale.US);

            if ("login_hint".equals(lowerKey) || "authuser".equals(lowerKey)) {
                continue;
            }

            if ("prompt".equals(lowerKey)) {
                if (promptSlotIndex < 0) {
                    promptSlotIndex = outPairs.size();
                    outPairs.add("");
                }
                collectPromptTokens(rawVal, extraPromptTokens);
                continue;
            }

            outPairs.add(pair);
        }

        StringBuilder promptValue = new StringBuilder("select_account");
        for (int i = 0; i < extraPromptTokens.size(); i++) {
            promptValue.append("%20").append(extraPromptTokens.get(i));
        }
        String promptPair = "prompt=" + promptValue.toString();

        if (promptSlotIndex >= 0) {
            outPairs.set(promptSlotIndex, promptPair);
        } else {
            outPairs.add(promptPair);
        }

        StringBuilder rebuilt = new StringBuilder(trimmed.length() + 32);
        rebuilt.append(base).append('?');
        for (int i = 0; i < outPairs.size(); i++) {
            if (i > 0) {
                rebuilt.append('&');
            }
            rebuilt.append(outPairs.get(i));
        }
        rebuilt.append(fragment);
        return rebuilt.toString();
    }

    private static boolean isOAuthAuthorizePath(String path) {
        if (path == null) {
            return false;
        }
        String lower = path.toLowerCase(Locale.US);
        return lower.startsWith("/o/oauth2/")
                && (lower.endsWith("/auth") || lower.endsWith("/auth/"));
    }

    private static void collectPromptTokens(String rawVal, List<String> dest) {
        if (rawVal == null || rawVal.isEmpty()) {
            return;
        }
        String decoded;
        try {
            decoded = URLDecoder.decode(rawVal, "UTF-8");
        } catch (Exception e) {
            decoded = rawVal.replace("%20", " ").replace('+', ' ');
        }
        String[] tokens = decoded.trim().split("\\s+");
        for (int i = 0; i < tokens.length; i++) {
            String tok = tokens[i];
            if (tok.isEmpty()) {
                continue;
            }
            String lower = tok.toLowerCase(Locale.US);
            if ("select_account".equals(lower) || "none".equals(lower)) {
                continue;
            }
            if (isSafePromptToken(lower) && !dest.contains(lower)) {
                dest.add(lower);
            }
        }
    }

    private static boolean isSafePromptToken(String token) {
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '_' || c == '-';
            if (!ok) {
                return false;
            }
        }
        return !token.isEmpty();
    }
}
