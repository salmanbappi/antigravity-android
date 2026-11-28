---
name: github
description: >-
  Interact with GitHub repositories, pull requests, issues, and workflows using
  one or more local GitHub accounts managed by the Antigravity GitHub plugin.
  Use whenever the user asks to work with GitHub or switch between labeled
  GitHub accounts (e.g. personal, work).
---

# GitHub (Multi-Account Plugin)

Use connected local GitHub Personal Access Tokens (PATs) managed in
**Customizations → Installed → Plugins → GitHub (Local)** to run `gh` and `git` commands
without storing plaintext tokens in scripts or asking the user to paste secrets
into chat.

## Checking Connected Accounts

Always call `list_plugin_accounts` before running GitHub commands so you know:
1. Whether at least one `github` account is connected.
2. Which account is the default, and the exact account names (`account-1`,
   `account-2`, or resolved GitHub usernames) and user-assigned labels (such as
   `personal` or `work`).

If no `github` account is connected, ask the user to open
**Customizations → Installed → Plugins → GitHub (Local)** and add a Personal Access
Token. Do not ask the user to paste their token into chat.

## Selecting an Account (`AGY_ACCOUNT`)

- **Default account:** Run `gh` or `git` directly; Antigravity automatically
  injects `GH_TOKEN` and `GITHUB_TOKEN` for the default connected account.
- **Specific account:** Prefix the command with `AGY_ACCOUNT=<account>`, where
  `<account>` is the account **name** returned by `list_plugin_accounts` (not
  its human label):
  ```bash
  # Example: user asked to use their "work" account whose account name is account-2
  AGY_ACCOUNT=account-2 gh api user --jq .login
  AGY_ACCOUNT=account-2 gh pr list --repo org/repo
  ```
- Never run `gh auth login` or inspect environment variables to print `GH_TOKEN`
  or `GITHUB_TOKEN`.

## Common Workflows

If `gh` is not installed yet on Android, install it with `pkg install gh` (or
use `git` / `gh` as available).

```bash
# Verify which GitHub user is active for a given account
gh api user --jq .login
AGY_ACCOUNT=<account> gh api user --jq .login

# List repositories, PRs, and issues
gh repo list --limit 20
gh pr list --state open
gh issue list --state open

# View workflow runs
gh run list --limit 10
```

## Notes

- Credentials stay on-device and are scoped to `api.github.com`, `github.com`,
  and `uploads.github.com`.
- If a command returns `403` or `404` on a private repository, check that the
  correct account is selected via `AGY_ACCOUNT` and that its PAT includes the
  required scopes (`repo`, `read:org`, `workflow`).
