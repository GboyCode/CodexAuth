# CodexAuth Switch

![CodexAuth Switch poster](docs/assets/readme-poster.png)

English README | [中文说明](README.md)

CodexAuth Switch is a local Windows and macOS desktop utility for quickly switching between multiple Codex App login accounts.

It is designed for people who use more than one OpenAI / Codex App account. Start official sign-in from the panel or save the current login, then switch the active Codex account through this tool. Credentials are stored locally. Quota and usage views come from local Codex logs; it does not call remote quota endpoints or upload Codex conversation history.

One-line positioning: **CodexAuth Switch is a local-first Codex App multi-account switcher with `auth.json` snapshot management, Windows DPAPI / macOS Keychain encryption, quota display, and token usage statistics.**

> This is an unofficial project and is not affiliated with OpenAI.

**Latest: [v0.1.36](https://github.com/GboyCode/CodexAuth/releases/tag/v0.1.36)** · [Release notes](docs/releases/v0.1.36.md) · [Issues](https://github.com/GboyCode/CodexAuth/issues)

This release adds sign-in without logging out of the active account, improves quota recovery and Business fallback selection, speeds up local usage reads, and adds credential race protection, email hiding, and sidebar update links.

## Who It Is For

- Users who manage multiple Codex App login accounts on Windows or macOS.
- Users who want to switch the active OpenAI Codex / Codex App account quickly.
- Users who want to safely save and restore local `~/.codex/auth.json` login snapshots.
- Users who want to view local session quota, weekly quota, remaining resets, token usage, and project/model statistics.
- Users who want local log estimation without sending tokens, account data, or conversation history to remote quota endpoints.

## Search Keywords

Codex account switcher, Codex multi account, Codex App account manager, OpenAI Codex account switcher, Codex auth.json switcher, Codex local login manager, Codex quota viewer, Codex token usage dashboard, Codex Windows macOS desktop app, Codex DPAPI Keychain encryption, Codex local quota estimate, Codex local quota tracking, Codex local history read-only.

## Features

- **Sign-in and account management**: official browser authentication from the panel, automatic encrypted import without logging out, existing-login import, account names and switching.
- **Credential protection and migration**: Windows DPAPI / macOS Keychain snapshots, backups before changes, password-encrypted `.codexauth` import/export, and stale-credential warnings.
- **Automatic recovery (Windows, opt-in)**: native quota-failure detection, a cancellable 15-second countdown, idle-task and live-quota checks, and continuation of eligible tasks and goals.
- **Account selection**: Plus, five-hour Business, then weekly-only Business; skip unreset windows with at most 2% remaining, and try Business with unknown quota last.
- **Local quota and usage**: quota windows, reset counts, project/model statistics, incremental log reads and shared refreshes. Data timestamps and scopes are explicit; local totals are not official lifetime totals.
- **Widget and privacy display**: main window, tray and quick-switch widget; hide emails in the quota overview and expand credential-storage or compatibility details.
- **Project links**: GitHub icon, actual app version, manual update checks and developer WeChat QR code.

Automatic task recovery is Windows-only. macOS supports account management, quota, usage and credential migration; native macOS sign-in, Keychain and GUI behavior still require end-to-end testing.

## Screenshots

| Main Window | Floating Quick View |
| --- | --- |
| ![CodexAuth Switch main window screenshot](docs/assets/screenshot-dashboard.png) | ![CodexAuth Switch floating widget screenshot](docs/assets/screenshot-widget.png) |

## Safety Boundary

CodexAuth Switch is intentionally scoped to the local Codex login file and the app's own storage directory.

### Files It Writes

- `~/.codex/auth.json`
  - The active local login file used by Codex App.
  - During account switching, the app replaces this file with a saved account snapshot.
- `~/.codex/config.toml`
  - Ensures the top-level setting contains `cli_auth_credentials_store = "file"` so current Codex releases continue using switchable `auth.json` credentials.
  - Creates a timestamped `config.toml.codexauth-backup-*` copy in the same directory before changing the file.
- App account metadata: `%APPDATA%\codex-auth-switcher\accounts.json` on Windows; `~/Library/Application Support/codex-auth-switcher/accounts.json` on macOS.
- Encrypted account snapshots: `%APPDATA%\codex-auth-switcher\accounts\*.dpapi` on Windows; `~/Library/Application Support/codex-auth-switcher/accounts/*.keychain` on macOS.
- Encrypted backups created before operating on the active account: `%APPDATA%\codex-auth-switcher\backups\*.dpapi` on Windows; `~/Library/Application Support/codex-auth-switcher/backups/*.keychain` on macOS.

### Files It Only Reads

- `~/.codex/auth.json`
  - Used to import the current login and identify the account.
- `~/.codex/sessions/**/rollout-*.jsonl`
  - Used for local usage and quota snapshot calculation.
- `~/.codex/session_index.jsonl`
  - Used to enrich local session metadata when available.
- `~/.codex/logs_2.sqlite`
  - Opened in read-only mode to read local Codex quota events.

### What It Does Not Do

- It does not directly rewrite existing conversation logs; opt-in recovery lets Codex receive continuation messages and append normal task records.
- It does not delete `~/.codex/sessions`.
- It does not write to `logs_2.sqlite`.
- It does not upload credentials, account data, logs or usage to the project author or third parties. User-triggered official sign-in and continuation communicate with OpenAI through Codex.
- It does not use the current access token to request remote quota endpoints.
- It does not refresh OpenAI tokens by itself.
- It does not call remote quota endpoints.

Features that intentionally affect Codex App runtime state include account switching, reauth, deleting the active account, restarting Codex App, and opt-in automatic switching and continuation. These actions may update `config.toml`, replace or remove the current `auth.json`, and restart Codex App so the new local login state takes effect. Automatic continuation also asks the local Codex interface to verify the active account's quota and send a continuation prompt; Codex itself performs the associated service requests.

## How It Works

### Account Identification

When importing the current login, the app reads `~/.codex/auth.json` and validates that it matches Codex App's ChatGPT login format.

It parses JWT payloads locally and extracts fields such as email, user ID, and workspace/account ID. Account matching does not rely on a single claim. It combines personal identity and workspace identity when possible, because one person can belong to multiple workspaces and one workspace can contain multiple users.

### Credential Storage

Saved account snapshots are encrypted with Windows DPAPI or Electron `safeStorage` backed by macOS Keychain. During panel sign-in, the official helper temporarily stores plaintext `auth.json` under `login-sessions/login-*` in the app data directory. These files are removed after import, cancellation or failure; the next app launch retries cleanup of leftovers.

Windows uses `DataProtectionScope.CurrentUser`; macOS uses the current user's Keychain.

This binds encrypted snapshots to the current operating-system user. Other users, machines, or operating systems cannot directly decrypt them.

Saved account snapshots are stored in:

- Windows: `%APPDATA%\codex-auth-switcher\accounts`
- macOS: `~/Library/Application Support/codex-auth-switcher/accounts`

Backups created before operating on the active login are stored in:

- Windows: `%APPDATA%\codex-auth-switcher\backups`
- macOS: `~/Library/Application Support/codex-auth-switcher/backups`

The app does not call an OpenAI token-refresh endpoint itself. Codex refreshes access and refresh tokens during actual use; CodexAuth Switch watches the current `auth.json` and re-encrypts updated contents into the matching account snapshot. An expired access token alone does not mean the login is invalid—reauth is needed only when Codex can no longer refresh it.

The newest 60 encrypted backups are retained. Atomic-write temporary files older than one hour are cleaned at startup so long-running switching and usage tracking do not create unbounded cache growth.

### Account Switching Flow

When switching accounts, the app:

1. Decrypts and validates the target snapshot and identity.
2. Stops the desktop and its app-server when restart is enabled, or requires clients to be closed first. A running independent CLI blocks switching.
3. Reads the final old credential, saves it, and creates an encrypted backup; backup failure blocks replacement.
4. Rechecks client shutdown and target identity, then atomically replaces `auth.json` through a temporary file.
5. Reads back the identity, updates saved account metadata and starts Codex if enabled.

The temporary-file plus atomic-rename approach reduces the chance that Codex App reads a partially written `auth.json`.

On Windows, restart stops the desktop process group belonging to the Codex installation. On macOS, it detects the current `ChatGPT` or legacy `Codex` application process, waits for it to exit, and relaunches it through Launch Services.

### Reauth Flow

If a saved account's refresh token becomes invalid, the app can start a reauth flow:

1. Stop the desktop and its app-server and verify no other Codex clients remain.
2. Encrypt a backup of the final `auth.json`, then remove the current login; stop if backup fails.
3. Start Codex App.
4. Let the user complete the official login flow inside Codex App.
5. After Codex App writes a fresh `auth.json`, CodexAuth Switch watches for it and saves it back to the matching account.

This does not bypass or replace official login. The real login still happens inside Codex App.

### Automatic Switching and Continuation

The optional recovery toggle is off by default. Every 15 seconds it checks local tasks for explicit new quota failures or goals in `usageLimited`. A nearly empty widget estimate alone does not trigger switching.

Candidates are ranked by plan, estimated balance and reset time. Reauthentication flags, cooldowns, stale snapshots and unreset low balances exclude an account; unknown-quota Business accounts are last. Each attempt has a cancellable countdown and waits for other work to finish. Only verified target identity and live availability allow a visible continuation message to the original task. Goal objective, budget and accounting are preserved.

This continues existing context rather than restoring process state. Manual account operations cancel pending recovery; uncertain sends are never replayed. Recovery tries to open the first confirmed task once. Requires a compatible Windows desktop interface and never automatically consumes reset credits.

### Quota Mode

The quota panel uses local estimate mode only. It reads logs already written by Codex App and does not request `chatgpt.com` or any other remote quota endpoint.

### Local Quota And Usage

Local estimate mode reads:

- `codex.rate_limits` records in session JSONL files.
- `codex.rate_limits` and usage-limit records in the latest automatically discovered `logs_N.sqlite`.
- `token_count` events in session files.
- Complete log events, cached by file size and modification time and deduplicated across files. Account metadata stores quota snapshots and calibration samples isolated by model and service tier. The legacy `local-token-ledger.json` no longer participates in statistics.

The app watches local log file changes with a short debounce and uses a low-frequency SQLite modification-time polling fallback to avoid missed filesystem events.

Quota snapshots are saved only into this app's own account metadata. They are not written back to Codex log files.

Multi-account statistics use the most recent account-switch time as their boundary. A session that continues across a switch is attributed through adjacent token-snapshot deltas, and quota calibration combines only post-switch events with that account's own saved learning so same-plan accounts do not leak into each other.

### Quota Pace Hints

The app uses the current used percentage, quota window length, and reset time to estimate consumption pace. It can show whether usage is light, on track, or likely to run out early. This is a trend hint, not a promise of how much quota the next request will consume.

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

These restrictions keep renderer pages local-only and help prevent account data or local history from being uploaded. Quota reading also stays local-only.

The explicit exception is a user-triggered update check: the main process makes a separate HTTPS request to this repository's fixed public GitHub endpoint. Only matching installer links within this repository are accepted and opened in the system browser. GitHub login data and Codex credentials are not read.

User-triggered account sign-in also connects to OpenAI authentication services through the system browser and an isolated official Codex helper, using the official local callback. Renderer pages remain offline.

## Usage

### Install Dependencies

```powershell
npm install
```

### Start The App

```powershell
npm start
```

Hidden local debug start on Windows:

```powershell
npm run dev:hidden
```

### Import Accounts

1. Install Codex desktop and open CodexAuth Switch.
2. Click “登录并添加账号” (Sign in and add account).
3. Select the desired account on the official page and complete authentication.
4. The encrypted account is added automatically; the active Codex login stays unchanged.
5. Repeat to add more accounts, or use “导入当前登录” to import an existing active login.

If the browser selects an existing account automatically, choose the intended account on the official page. Pending sign-in can be cancelled or reopened and times out after five minutes.

### Switch Accounts

1. Select a saved account in CodexAuth Switch.
2. Click switch.
3. Enable restart to stop and relaunch Codex automatically; otherwise close Codex App and CLI before switching, then start Codex manually.

The app pins current Codex releases to file-backed credentials and fully restarts the desktop app when “restart after switch” is enabled, so the selected account takes effect after relaunch.

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
npm run local-data:validate
```

This command uses isolated fixtures to validate token deltas, duplicates and forks, account boundaries, quota pools, weekly windows, reset-credit provenance, calibration and account recovery. `quota:validate` remains a historical replay of the old price-weighted algorithm, not validation of the current algorithm.

### Validate Account Login and Recovery

```powershell
npm run account-login:validate
npm run account-safety:validate
npm run auto-recovery:validate
```

These checks use fake credentials and isolated directories, without real account switching. Both Windows and macOS release jobs run the complete release checks.

### Build Windows Installer

```powershell
npm run pack:win
```

### Build macOS DMGs

Run this command on macOS:

```bash
npm run pack:mac
```

It creates DMGs for Intel (`x64`) and Apple Silicon (`arm64`).

The installers are written to:

```text
release/
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

- Windows and macOS are supported; Linux is not currently supported.
- Encrypted snapshots are bound to the current system user and cannot be copied directly across machines or platforms.
- This targets Codex App local login switching, not Codex CLI-only workflows.
- Local estimate mode is a best-effort interpretation of local logs.
- Quota snapshots may stay stale until Codex writes new local rate-limit records.
- Do not share saved credential snapshots across machines or operating-system users.

## Release

Windows installers and Intel / Apple Silicon macOS DMGs are uploaded through GitHub Releases. The current builds are not commercially code-signed or Apple-notarized, so the operating system may show a security warning.

## License

MIT License. See [LICENSE](LICENSE).

## Responsible Use

Only save and switch accounts that you own or are authorized to use. Do not share `auth.json`, encrypted snapshots, or backup files with other people.

## Version History

<details>
<summary>Expand historical development notes (current feature documentation takes precedence)</summary>

## 0.1.36: Developer WeChat contact

The sidebar developer link now opens `https://ryanlin.me/assets/contact/wechat-qr.png` in the system browser and is labeled “开发者微信” (Developer WeChat).

## 0.1.35: Sidebar project and update links

Below local diagnostics, the sidebar now shows a GitHub icon and project link, the running app version, an update-check button and developer Ryan Lin's website. Links open this repository or `https://ryanlin.me` in the system browser. Version text comes from the app. Header and sidebar share the existing update check and display newer-release, up-to-date, newer-local-build or failure status; network access remains user-triggered.

## 0.1.34: Skip near-empty accounts and add a Business fallback

Automatic recovery skips an account when any quota window has 2% or less remaining and has not reached a valid reset time. An unknown reset time does not lift this restriction. A passed reset can make that window eligible again, subject to other windows and live verification. This threshold is a selection rule, not proof of official exhaustion.

Existing plan priority is unchanged. Business accounts (including `team`) with missing or unknown quota are attempted only after recorded candidates are unavailable; unknown quota is never treated as 100%. A known low window cannot become a fallback because another window is missing. Reauthentication requirements, exhaustion cooldown and the seven-day limit for recorded snapshots remain in place.

Each attempt retains the cancellable countdown, idle checks and live identity/quota verification before continuation. All unavailable candidates lead to waiting, not repeated restarts. Simulated boundary, reset, weekly bottleneck, fallback sequence, cancellation, cooldown and restart recovery checks passed; no real-account exhaustion test was performed.

## 0.1.33: Sign in and add accounts directly

The account panel now opens the installed Codex app-server's [official browser sign-in flow](https://learn.chatgpt.com/docs/app-server). Complete authentication in your system browser to import an encrypted account without logging out of or switching the active Codex account. Cancel, reopen and a five-minute timeout are supported. Existing accounts are updated; the active identity retains its live credential.

The helper uses an isolated temporary `CODEX_HOME`, without the real configuration, sessions or credentials, and starts no model tasks. The official helper temporarily writes plaintext `auth.json` there. Imported snapshots use existing DPAPI / Keychain encryption; temporary files are cleaned after completion, cancellation or failure, and leftovers are cleaned on the next launch. Automatic switching pauses while login is pending. Passwords and verification codes stay on the official page.

Isolated import, duplicate identity, encrypted rollback, cancellation, timeout and UI checks passed. Starting and cancelling the installed official login flow preserved the real auth and configuration. Real user authentication and macOS runtime behavior remain untested. Run `npm run account-login:validate`.

## 0.1.32: Credential switching and recovery race fixes

Account switching now stops the desktop and its app-server before saving the final old credential, backing up, replacing auth, and checking the target identity. Remaining independent Codex CLI clients block the change; they are not automatically terminated. Switching without restart requires clients to be closed first. Re-login and active-account deletion follow the same ordering, and backup failures block replacement.

Quota validation, goal recovery and continuation share the manual account-operation queue. Manual login operations immediately invalidate and persist cancellation of pending recovery. Identity is checked again before goal mutation and transport dispatch; the goal helper must exit before the queue is released.

Older, undated or conflicting same-date imports show a rollback warning and require re-login. Import, metadata hydration and unchanged-file synchronization preserve existing re-login markers. Validation uses fake credentials, mocked processes and desktop services, plus a local pipe. No real-account switching or exhaustion test was performed; external clients do not share a global file lock, and platform enforcement is outside these fixes.

## 0.1.31: Hide account emails in the quota overview

The all-accounts quota overview now has an eye toggle beside its heading. It replaces account names with numbered aliases and restores them on the next click. The local display preference survives refresh and restart and applies only to this overview.

## 0.1.30: Compact switch reminder and automatic task navigation

The switch reminder is now a 320 × 112 card matching the widget, retaining the 15-second countdown, cancel button and Escape shortcut. Target account and task count are available on hover instead of in a large text block.

After confirming the original task has a new continuation turn, recovery opens it through Codex's `navigate_to_codex_page`. A batch opens only its first confirmed task once. Navigation failure or an unsupported interface does not interrupt recovery or resend a continuation; the status suggests opening the task manually. The rendered card, countdown/cancel interaction, batch deduplication and failure isolation were checked, and the local task navigation interface was exercised successfully.

## 0.1.29: Recognize Plus usage-limit failures without error codes

Recognizes the complete native `You’ve hit your usage limit. Upgrade to Pro (...)` template when the desktop returns it in a failed turn without an error code. Recovery is triggered by the failed turn, not by the widget estimate reaching zero; a 99%-used snapshot does not suppress exhaustion detection. Busy-task checks, the cancellable 15-second countdown, post-switch verification and continuation deduplication are retained.

Regression fixtures based on the observed local error verify countdown, switching and continuation with 1% remaining. A 99% snapshot alone, completed/interrupted turns, historical failures, tool text and non-quota errors do not trigger recovery. The full production flow has not been tested by exhausting another real account.

## 0.1.28: Distinguish local usage from official lifetime totals

The current-account usage scope is now labeled as the current local period, with its account-switch start time shown above the metrics. All-local usage explicitly includes different accounts. Missing login, an untracked account, or a missing switch boundary yields unknown usage instead of assigning all local history to the current account.

The official profile's lifetime token count comes from server-side `stats.lifetime_tokens`, with a `stats_as_of` cutoff. Local event totals are a different metric. The observed official profile cache has no account identifier, so the active login or cache timestamp alone cannot safely assign it to an account. This version retains local-only reads and adds no official network queries.

## 0.1.27: Faster usage reads and more accurate attribution

Current-account statistics skip session files last modified before the account switch. Growing JSONL logs retain parsing checkpoints and process appended data only. Incomplete lines are re-read after completion; truncation, replacement or detected rewrites trigger full parsing. Compressed archives retain full reads. Concurrent refreshes share work, and invalidated in-flight requests cannot refill a newer cache.

Independent sessions with coincident timestamps and token counters are no longer incorrectly deduplicated; copies and inherited fork history remain deduplicated. Project usage follows the directory at each event. Switching between current-account and all-local statistics cannot be overwritten by an older response.

In a local benchmark with approximately 2.8 GB across 240 log files, initial current-account usage loading fell from 12.7 seconds to 0.11 seconds by reading 5 relevant files. Appending to a roughly 12 MB fixture fell from 30 ms to 1 ms. Fixed event samples preserved all token totals, and incremental, concurrent, compressed-log, deduplication and scope regression checks passed. Results vary with local data; the first all-local read still scans historical logs, and totals remain limited by local log coverage.

## 0.1.26: Detect exhausted workspace credits and recover connection status

Recognizes failed turns where Codex reports `Your workspace is out of credits. Add credits to continue.` without an error code. Only the latest eligible failure after enablement is handled; ordinary network/tool errors, manual interruptions and failures already followed by another turn remain excluded.

Read-only probes rediscover the local endpoint and retry once after a transport failure. Continuation requests are never automatically replayed. A successful scan clears a stale connection error. Validated the observed error shape, simulated switching/recovery, reconnection and duplicate-send guards, plus read-only connectivity to the installed desktop. The full flow has not been retested by exhausting a real account.

## 0.1.25: Goal mode recovery

The existing automatic recovery toggle now recognizes local goals entering `usageLimited` after enablement, including interruptions between goal turns. Multiple goals share the existing batch recovery and cancellable countdown. Manually paused, blocked, completed, budget-limited and historical goals are excluded. Other active goals prevent restarting, including idle gaps between turns.

After verifying the new account and quota, Codex's `thread/goal/get` and `thread/goal/set` APIs restore only the original goal's status, preserving its objective, budget, token usage and elapsed time. A short-lived metadata helper never loads a thread or starts model work; continuation uses the desktop app. Recovery confirms both a new turn and the original goal's running state. Incompatibility or uncertain results require manual inspection without duplicate sends. Requires a compatible Windows Codex desktop installation.

Validated simulated batch recovery and cancellation/state-change guards, plus the installed Codex goal API in an isolated home with preserved accounting and no model turn. Real quota exhaustion, account switching, restart and sustained goal continuation have not been tested end to end.

## 0.1.24: Fix multiplatform releases

Credential file associations now use platform-specific configuration: Windows keeps its dedicated ICO, while macOS uses the generated application icon. This fixes the missing ICNS resource during Mac packaging. Includes the countdown, cancellation, automatic recovery and batch credential migration updates from 0.1.23. Automatic recovery remains Windows only.

## 0.1.23: Countdown and cancellation before switching

The long explanation is now behind a hover/focus information icon. Before every automatic switch, including fallback accounts, an always-on-top reminder beside the floating widget shows the target account and a 15-second countdown. Cancel, close, or Escape skips this batch of interrupted turns without disabling recovery for new failures. Cancellation persists across application restarts.

The countdown starts after the reminder loads. Disabling recovery, a failed reminder, or a sleep/stall that skips the countdown cancels the operation. Accounts and task activity are checked again afterward. Recovery sends a continuation message to the original task; it does not restore an interrupted process. A real quota-exhaustion recovery has not been tested end to end.

## 0.1.22: Account priority by plan and five-hour limit

Automatic recovery now prefers **Plus → Business with a five-hour limit → weekly-only Business without a five-hour limit**. The local `team` plan name is treated as Business; a recorded 300-minute quota window identifies the five-hour variant. Within each group, higher estimated remaining quota comes first, then the earlier upcoming reset. Other plans and ambiguous window metadata come last. Existing availability checks and exhausted-account exclusions still apply.

## 0.1.21: Optional automatic account switching and task continuation

Enable the new toggle in the account page's switching settings (off by default). Every 15 seconds, CodexAuth checks local tasks for explicit quota exhaustion failures occurring after enablement. It uses the plan priority above, then ranks each group by the lower estimated remaining session/weekly percentage, breaking ties by the earliest upcoming reset. Recorded snapshots older than seven days and unreset windows with 2% or less remaining are excluded. Only Business accounts with missing or unknown quota can serve as the final fallback. Passed reset times may make an account a candidate, but are never treated as verified availability: after switching, Codex verifies the active account and actual quota before continuing. An unavailable candidate is skipped for another account and excluded for 30 minutes.

Recovery waits for other local tasks to finish, switches credentials using the existing backup flow, restarts Codex, verifies the target account and available quota, then sends a visible continuation prompt to the original task without changing its model or permissions. Restart is required regardless of the manual-switch restart preference. A durable local `auto-recovery.json` journal prevents duplicate sends. Disabling cancels subsequent recovery steps; already started tasks continue. Reset credits are never automatically consumed.

Currently Windows only. Keep CodexAuth running and the Codex task window available. The desktop app-tools interface is version-dependent; incompatibility or recovery errors appear beside the toggle. Read-only desktop integration and simulated recovery have been validated; a real quota-exhaustion account switch has not been tested.

## 0.1.20: Select files before entering the import password

The credential importer now opens a multi-select file picker first (up to 100 files), then asks once for their shared migration password. Retry an incorrect password without selecting the files again. Import files with different passwords separately. The whole batch is validated before writing; existing accounts use one update confirmation, and the current login is preserved.

## 0.1.19: Refresh credential icons after installation

Notify Explorer after the `.codexauth` file type and icon have been registered, so an open folder does not keep the old generic file type and blank icon after an upgrade.

## 0.1.18: Credential file icon

The Windows installer now installs a standalone ICO for `.codexauth` credentials and registers it as the file type icon. Reinstalling refreshes the association and notifies Explorer. Credentials are still imported through the main window.

## 0.1.17: Export the current account or all accounts

Click **Export account credentials** and choose the current account or all accounts. Export all creates a new folder containing one encrypted `.codexauth` file per saved account, including the current login without duplicates. All files use the chosen migration password, and the current account uses its latest credentials. Each file works with the existing importer.

## 0.1.16: Reset-credit cache and snapshot fixes

Discover redirected Codex cache profiles from Windows Store / MSIX installations and continue past damaged responses in cache hash chains. Account-verified reset credits can now be read without a switch timestamp and saved without a new quota event. Concurrent refreshes preserve the newest reset record, including snapshots with no quota windows. All quota reads remain local; missing records remain unknown.

## 0.1.15: Version display and GitHub update checks

Click the version above the main window title or beside the widget brand to check the latest public GitHub release. A newer release offers the installer matching the current OS and architecture; Download opens it in your browser for manual installation. Failed checks can be retried, and newer local builds are not offered a downgrade.

Checks are manual and send no account, credential or usage data. There are no background checks or automatic installs. Uses the public [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## 0.1.14: Credential file icon

After installation, `.codexauth` encrypted credential files use the CodexAuth app icon. Use Import credentials in the main window to import a file.

[Download the latest release](https://github.com/GboyCode/CodexAuth/releases/latest) · [Full v0.1.15 release notes](docs/releases/v0.1.15.md)

## 0.1.13: portable account credentials

Use **Export current account** on computer A with a migration password of at least 10 characters. Install this version or newer on computer B, import the encrypted `.codexauth` file with the same password, then select **Switch** for the imported account. Importing does not automatically change the active login or restart Codex.

The file encrypts account labels and credentials using scrypt and AES-256-GCM. Imported credentials are protected again by the destination's DPAPI or macOS Keychain. Updating an existing inactive account requires confirmation and creates a local encrypted backup; an already active account keeps its local credentials. Passwords are not saved or recoverable.

Valid credentials may avoid signing in again, but cannot bypass verification. Expiration, revocation or refresh-token rotation can require a new export or official sign-in. Validate with `npm run portable:validate`.

## 0.1.12: simplified quota display

- Remove additional quota pools from the widget, account details and usage dashboard. Session quota, weekly quota and reset counts remain available.
- Reduce the widget minimum height while retaining two complete account rows.

## 0.1.11: startup race fix

- Repeated launches wait for initialization and IPC registration before opening either window, preventing the missing `state:get` handler error.
- Initialization failures show an error and exit. Validate with `npm run startup:validate`.

## 0.1.10: widget minimum-height fix

- Reserve enough minimum height for two complete account rows, including the additional-pool summary. Previously saved smaller bounds are corrected automatically.
- Compact the reset-count line and label its source as Codex cache.

## 0.1.9: per-account quick overview

- The widget account popover and main account details show saved reset counts, source, timestamp and additional quota pools for each account.
- Snapshots remain available after switching accounts. Missing values stay unknown and stale reset counts are labeled; no online refresh is performed for other accounts.

## 0.1.8: local reset-credit cache support

- Read existing Codex browser usage-response caches after matching both account ID and user ID to the active account.
- Label the cache source and timestamp, with stale-data indicators. Missing or unverifiable data remains unknown; no official API requests are made.
- Validate with `npm run browser-cache:validate`.

## 0.1.7: local compatibility and statistics

- Quotas are separated by limit ID, with correct weekly-only window placement. Null usage means unknown.
- Token totals use event deltas across sessions and archived sessions, with copied-event deduplication, per-model/day attribution and gzip/Zstandard support where the runtime supports it. Cached input and reasoning output are subsets, not additional tokens. Exact counts and scan coverage are shown. Counter resets or missing baselines are reported rather than guessed.
- Quota estimates learn only from this account's local samples for the same model, explicit speed tier, limit ID and window. Unknown/new models do not inherit GPT-5.5 prices. At least three local samples are required; snapshots remain visible without calibration.
- Earned reset counts are shown only from structured local Codex records. Missing data is Unknown, not zero. Stale or expired records are labeled; there are no online queries or reset-redemption actions.
- Local diagnostics show the running app version, credential sync and log availability. A corrupted account index is recovered from decryptable snapshots after preserving the damaged index and encrypted blobs in a recovery directory.
- Run `npm run local-data:validate` for the fixture-based parser, recovery and integration checks.

</details>
