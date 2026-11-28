# GitHub (Local) Plugin

Bundled local multi-account GitHub plugin for Antigravity (seeded into
`~/.gemini/config/plugins/github/`).

## Features

- **Direct local browser login (GitHub Device Flow):** Sign in or add multiple
  GitHub accounts directly via your browser using GitHub's OAuth 2.0 Device Flow
  (`https://github.com/login/device/code` and
  `https://github.com/login/oauth/access_token`, public client ID, zero
  `client_secret`, zero third-party proxy). Manual Personal Access Token (PAT)
  paste remains available as a fallback. Credentials stay local on this device.
- **Account labels & defaults:** Label each account (for example `personal`,
  `work`, `oss`), choose a default account, and let agents target specific
  accounts with `AGY_ACCOUNT=<account>`.
- **Automatic identity detection:** Resolves each connected token's GitHub
  username via `https://api.github.com/user` (`login`).
- **CLI credential injection:** Automatically provides `GH_TOKEN` and
  `GITHUB_TOKEN` to `gh` and `git` commands scoped to `api.github.com`,
  `github.com`, and `uploads.github.com`.

## Files

- `plugin.json` — Plugin manifest (`github`, display name `GitHub (Local)`,
  icon, starter prompts).
- `auth.json` — `api_key` auth provider with `env` delivery (`GH_TOKEN`,
  `GITHUB_TOKEN`), Bearer header config, and GitHub `/user` identity probe.
- `assets/logo.svg` — GitHub Octocat icon.
- `skills/github/SKILL.md` — Agent instructions for `list_plugin_accounts` and
  `AGY_ACCOUNT` multi-account usage.
