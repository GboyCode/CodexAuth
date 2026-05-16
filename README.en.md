# CodexAuth Switch

![CodexAuth Switch poster](docs/assets/readme-poster.png)

English README | [中文说明](README.md)

CodexAuth Switch is a local Windows desktop utility for quickly switching between multiple Codex App login accounts.

It is designed for people who use more than one OpenAI / Codex App account. You can save each account's local login state, then switch the active Codex login through this tool. The project only operates on local files. It does not call OpenAI official APIs, does not access `chatgpt.com`, and does not upload Codex conversation history.

One-line positioning: **CodexAuth Switch is a local-first Codex App multi-account switcher with `auth.json` snapshot management, Windows DPAPI encryption, quota display, and token usage statistics.**

> This is an unofficial project and is not affiliated with OpenAI.

## Who It Is For

- Users who manage multiple Codex App login accounts on Windows.
- Users who want to switch the active OpenAI Codex / Codex App account quickly.
- Users who want to safely save and restore local `%USERPROFILE%\.codex\auth.json` login snapshots.
- Users who want to view local Codex quota, 5-hour quota, weekly quota, token usage, and recent sessions.
- Users who want a local-only tool that does not call OpenAI official APIs or upload Codex conversation history.

## Search Keywords

Codex account switcher, Codex multi account, Codex App account manager, OpenAI Codex account switcher, Codex auth.json switcher, Codex local login manager, Codex quota viewer, Codex token usage dashboard, Codex Windows desktop app, Codex DPAPI encryption, Codex no official API calls, Codex local history read-only.

## Features

- Import the current Codex App login state.
- Save multiple local account snapshots.
- Switch the active Codex login by replacing `%USERPROFILE%\.codex\auth.json`.
- Encrypt saved account credentials with Windows DPAPI, readable only by the current Windows user.
- Automatically back up the original `auth.json` before switching, reauth, or deleting the active account.
- Provide a main window, system tray menu, and floating quick-view widget.
- Read quota and token usage from local Codex logs.
- Disable network requests inside the app to keep it local-only.

## Screenshots

| Main Window | Floating Quick View |
| --- | --- |
| ![CodexAuth Switch main window screenshot](docs/assets/screenshot-dashboard.png) | ![CodexAuth Switch floating widget screenshot](docs/assets/screenshot-widget.png) |

## Safety Boundary

CodexAuth Switch is intentionally scoped to the local Codex login file and the app's own storage directory.

### Files It Writes

- `%USERPROFILE%\.codex\auth.json`
  - The active local login file used by Codex App.
  - During account switching, the app replaces this file with a saved account snapshot.
- `%APPDATA%\codex-auth-switcher\accounts.json`
  - Account metadata for this app.
- `%APPDATA%\codex-auth-switcher\accounts\*.dpapi`
  - DPAPI-encrypted account credential snapshots.
- `%APPDATA%\codex-auth-switcher\backups\*.dpapi`
  - Encrypted backups created before switching, reauth, or deleting the active account.

### Files It Only Reads

- `%USERPROFILE%\.codex\auth.json`
  - Used to import the current login and identify the account.
- `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl`
  - Used for local usage and quota snapshot calculation.
- `%USERPROFILE%\.codex\session_index.jsonl`
  - Used to enrich local session metadata when available.
- `%USERPROFILE%\.codex\logs_2.sqlite`
  - Opened in read-only mode to read local Codex quota events.

### What It Does Not Do

- It does not modify Codex conversation history.
- It does not delete `%USERPROFILE%\.codex\sessions`.
- It does not write to `logs_2.sqlite`.
- It does not upload tokens, account data, session logs, or usage records.
- It does not refresh OpenAI tokens by itself.
- It does not call OpenAI official APIs.

The only features that intentionally affect Codex App runtime state are account switching, reauth, deleting the active account, and restarting Codex App. These actions may replace or remove the current `auth.json` and restart Codex App so the new local login state takes effect.

## How It Works

### Account Identification

When importing the current login, the app reads `%USERPROFILE%\.codex\auth.json` and validates that it matches Codex App's ChatGPT login format.

It parses JWT payloads locally and extracts fields such as email, user ID, and workspace/account ID. Account matching does not rely on a single claim. It combines personal identity and workspace identity when possible, because one person can belong to multiple workspaces and one workspace can contain multiple users.

### Credential Storage

The app does not store `auth.json` in plain text. Saved account snapshots are encrypted through Windows DPAPI:

```text
DataProtectionScope.CurrentUser
```

This binds encrypted snapshots to the current Windows user. Other Windows users or other machines cannot directly decrypt them.

Saved account snapshots are stored in:

```text
%APPDATA%\codex-auth-switcher\accounts
```

Backups created before operating on the active login are stored in:

```text
%APPDATA%\codex-auth-switcher\backups
```

### Account Switching Flow

When switching accounts, the app:

1. Reads the current `%USERPROFILE%\.codex\auth.json`.
2. Creates a DPAPI-encrypted backup if a current login exists.
3. Decrypts the selected account snapshot.
4. Validates that the snapshot is a valid Codex login file.
5. Writes the snapshot to a temporary file.
6. Atomically renames the temporary file to `%USERPROFILE%\.codex\auth.json`.
7. Restarts Codex App if the user chooses to do so.

The temporary-file plus atomic-rename approach reduces the chance that Codex App reads a partially written `auth.json`.

### Reauth Flow

If a saved account's refresh token becomes invalid, the app can start a reauth flow:

1. Back up the current `auth.json`.
2. Delete the current local `auth.json`.
3. Restart Codex App.
4. Let the user complete the official login flow inside Codex App.
5. After Codex App writes a fresh `auth.json`, CodexAuth Switch watches for it and saves it back to the matching account.

This does not bypass or replace official login. The real login still happens inside Codex App.

### Local Quota And Usage

The quota and usage panels only read logs already written by Codex App:

- `codex.rate_limits` records in session JSONL files.
- `codex.rate_limits` and usage-limit records in `logs_2.sqlite`.
- `token_count` events in session files.

The app watches local log file changes with a short debounce and uses a low-frequency SQLite modification-time polling fallback to avoid missed filesystem events.

Quota snapshots are saved only into this app's own account metadata. They are not written back to Codex log files.

### Network Isolation

Electron windows use these security settings:

```js
contextIsolation: true
nodeIntegration: false
sandbox: true
webSecurity: true
```

The page CSP disables network connections:

```html
connect-src 'none'
```

The main process also installs an Electron `webRequest.onBeforeRequest` guard that cancels outbound requests for:

```text
http://
https://
ws://
wss://
```

These restrictions keep the app local-only and help prevent account data or local history from being uploaded.

## Usage

### Install Dependencies

```powershell
npm install
```

### Start The App

```powershell
npm start
```

Hidden local debug start:

```powershell
npm run dev:hidden
```

### Import Accounts

1. Open Codex App and sign in to the first account.
2. Open CodexAuth Switch.
3. Click the button that imports the current Codex login.
4. Return to Codex App, sign out, and sign in to another account.
5. Return to CodexAuth Switch and import again.
6. Repeat for every account you want to save.

### Switch Accounts

1. Select a saved account in CodexAuth Switch.
2. Click switch.
3. Restart Codex App if needed.

If Codex App has already loaded the old login into memory, the new account usually takes effect after restarting Codex App.

### Reauth A Saved Account

Use reauth when Codex reports that a refresh token can no longer be refreshed, or when a saved account has become stale.

The app clears the current local login and restarts Codex App. You then complete the official login inside Codex App. After Codex writes a new `auth.json`, CodexAuth Switch captures and saves it.

## Development

### Syntax Check

```powershell
npm run lint
```

### Validate Quota Logic

```powershell
npm run quota:validate
```

This command replays local `.codex` session logs and validates the quota-estimation logic. It only reads local session files and does not write to them.

### Build Windows Installer

```powershell
npm run pack:win
```

The installer is written to:

```text
release\
```

The `release` directory is a local build artifact and is not committed to Git by default.

## Project Structure

```text
src/main.js                         Electron main process, local file access, account switching, quota logic
src/preload.js                      Safe IPC bridge
src/ui/index.html                   Main window page
src/ui/app.js                       Main window renderer logic
src/ui/widget.html                  Floating quick-view widget page
src/ui/widget.js                    Floating widget renderer logic
scripts/generate-icon.js            Local icon generation
scripts/start-dev-hidden.ps1        Hidden debug start script
scripts/validate-quota-estimate.js  Quota replay validation script
QUOTA-LOGIC.md                      Quota-estimation notes
```

## Limitations

- Windows only for now.
- Credential encryption depends on Windows DPAPI.
- This targets Codex App local login switching, not Codex CLI-only workflows.
- Quota and usage display are best-effort interpretations of local logs.
- Quota snapshots may stay stale until Codex writes new local rate-limit records.
- Do not share saved credential snapshots across machines or Windows users.

## Release Notes

For a first GitHub release, upload the generated Windows installer from:

```text
release\CodexAuthSwitch-Setup-0.1.0.exe
```

The installer is not commercially code-signed, so Windows may show a security warning.

## License

MIT License. See [LICENSE](LICENSE).

## Responsible Use

Only save and switch accounts that you own or are authorized to use. Do not share `auth.json`, encrypted snapshots, or backup files with other people.
