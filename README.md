# CodexAuth Switch

Windows local desktop app for switching the active Codex App account.

## Run

```powershell
npm install
npm start
```

## Workflow

1. Open Codex App and sign in to one account.
2. Open this app and click `导入当前 Codex App 登录`.
3. In Codex App, sign out / sign in to another account.
4. Import that account too.
5. Use `切换` in this app to swap the active account.

## Storage

- Reads and writes `%USERPROFILE%\.codex\auth.json`.
- Saved account credentials are encrypted with Windows DPAPI for the current Windows user.
- Metadata and app cache are stored under `%APPDATA%\codex-auth-switcher`.
- Before each switch, the current `auth.json` is backed up as a DPAPI-encrypted snapshot under `%APPDATA%\codex-auth-switcher\backups`.
- Account matching uses a composite of person-level claims and the Business/workspace account id, because one Business workspace can contain multiple people and one person can belong to multiple workspaces.

## Notes

- This is for Codex App account switching. It does not depend on Codex CLI commands.
- Closing the main window hides the app to the Windows tray. Use the tray menu to reopen it or quit.
- The tray menu can open the main window, show/hide the floating quick-view card, switch saved accounts, and restart Codex App.
- The floating card shows the current account, local quota snapshot, restart action, and quick account switching.
- If Codex App has already loaded the old login, restart Codex App after switching.
- The optional restart button closes running `Codex` processes and relaunches the installed Codex App.
- While this app is running, it watches `%USERPROFILE%\.codex\auth.json` and also runs a low-frequency fallback sync to save fresh Codex-written credentials back into the matching saved account after official sign-in. If official sign-in returns a new identity that is not saved yet, it is imported locally as a new saved account.
- If Codex reports `Your access token could not be refreshed because your refresh token was already used`, that saved credential is already stale. Sign in again in Codex App and import the current login again.
- After switching, the app watches for Codex to write back a fresh login snapshot. If no refresh is observed, the account is marked as possibly needing reauth; the `重新登录` action encrypts a backup, clears the current local `auth.json`, and restarts Codex App so the official login flow opens.
- The quota and token usage panels only read local `%USERPROFILE%\.codex\sessions` logs and do not upload session data.
- After switching accounts, the quota panel prefers local Codex log entries generated after that switch. If none exist yet, it can show that same account's last captured local quota snapshot, but it will not reuse another account's latest snapshot. Token usage remains a local-history aggregate because Codex session logs do not currently include a stable account identifier.
- Saved quota snapshots are matched against the account plan type, so a Business quota snapshot is not shown as a Plus account snapshot.
- Codex local logs expose quota as `used_percent`; the UI labels it as used percentage and separately shows the remaining percentage.
- Token totals are raw local token counts and are not weighted by high-speed mode or model-specific quota multipliers. Use the quota snapshot cards for actual 5-hour and weekly quota percentage.
- The usage page refreshes from local logs periodically while the `用量` tab is open.
- Quota cards update from local Codex log writes with a short debounce, and only refresh the UI when the saved local quota snapshot changes.
- Continuous conversations may keep the quota snapshot unchanged until Codex writes the next local `rate_limits` record; the UI shows the snapshot time so stale local data is visible.
- When a later local `token_count` record exists but Codex has not written a new `rate_limits` record yet, the UI may show a separate estimated remaining percentage. The estimate is calibrated from local historical quota snapshots, is never saved as an official quota snapshot, and is only a local approximation.
- This app does not call `chatgpt.com` usage endpoints and does not refresh OpenAI tokens.
- Use only your own OpenAI accounts. Do not share saved account credentials with other people.
