# Local app and desktop UI

## Requirement source and owner

Requested on 2026-09-09: run Patchdeck Local beside production with live source updates, fix the desktop review findings, and bring the existing Tauri interface closer to macOS conventions. Integration owner: the primary coding agent. Native Swift migration and production release are outside this change.

## Intended behavior and acceptance examples

- Patchdeck Local has a distinct bundle identity, window title, and app data directory. Starting it does not replace or stop production. Frontend edits appear through Vite; Rust edits use Tauri's development rebuild.
- The welcome toolbar stays visible when recent projects scroll at 920 × 600. Empty toolbar areas drag the native window and controls remain clickable.
- A save response updates the editor's saved baseline without discarding text entered during the request. A subsequent save uses the new hash.
- Settings blocks background review shortcuts and restores focus when dismissed. Standard open and Settings shortcuts work outside dialogs.
- Linked reviews retain visible addition/deletion markers beside their comment controls.
- Appearance supports System, Light, and Dark, persists locally, and includes readable diff colors.

## Implementation and verification plan

Entries: `package.json`, `scripts/local-app.mjs`, `scripts/local-runner.sh`, `src-tauri/tauri.dev.conf.json`, `src-tauri/src/lib.rs`, `src/App.tsx`, `src/components/WorkspaceHeader.tsx`, `src/components/WelcomeScreen.tsx`, `src/appearance.ts`, `src/theme.css`, `src/settings/SettingsPanel.tsx`, `src/editor/FileEditor.tsx`, and `src/components/DiffView.tsx`.

Use focused Vitest regressions for save races, modal shortcuts, drag event routing, appearance preferences, and linked diff markers. Run `npm test`, `npm run build`, and `cargo test --locked` from `src-tauri`. Inspect the assembled interface at 920 × 600 and 1280 × 800. Build and launch the separate local app and inspect its process and bundle metadata. Native drag verification requires desktop interaction; browser routing tests alone do not prove native movement.

## Observed baseline

At commit `37c7ddf`, 130 frontend tests and the frontend build pass. Rust passes 56 tests with two environment-dependent tests ignored when built with a fresh target directory. The repository's previous target cache references its old directory. The installed production app uses `com.local.branchdiffviewer`, while source uses `com.local.patchdeck`; both report 0.5.0. The existing development config uses `com.local.patchdeck.dev` but has no dedicated live-app launch command.

## Observed implementation

- `npm run local:install` installs a signed local launcher in `/Applications/Patchdeck Local.app`. It starts `npm run local`'s development path, logs to `~/Library/Logs/Patchdeck Local/development.log`, and reopens the existing Local app when already running. Production is not replaced or terminated.
- The live app has identity `com.local.patchdeck.dev`. Its native bundle and compilation cache are under `src-tauri/target/local`. The Cargo runner prepares the bundle and uses shell `exec`, allowing Tauri to terminate the actual native process during rebuilds. Replacing the binary atomically avoids macOS code-signature cache failures.
- Session acquisition uses exclusive file creation. Duplicate launches cannot replace another session's lock. Clean exit removes it; stale locks fail with recovery instructions instead of deleting an uncertain owner. The launcher includes the user's `.local/bin` so Finder sessions can discover the installed agent CLIs.
- `src/App.tsx` handles keyboard and native `app-menu` events. Settings renders outside the inert app content. Review shortcuts reject events while a modal is present. Settings contains focus and restores the opener on dismissal.
- `FileEditor.save` updates only the saved baseline, leaving newer typing dirty. A generation counter ignores responses for a prior file, repository, or unmounted editor. Load and save failures retain a retry path.
- `DiffView` keeps change markers beside a separate comment gutter. `appearance.ts` is shared by startup and Settings; it resolves the saved preference before React mounts and subscribes to system appearance changes.
- Closing the window still hides it on macOS. Window geometry persists, but visibility no longer restores a hidden startup window. The welcome toolbar stays outside the scrolling content.

## Verified behavior

Verified on macOS, Apple silicon, on 2026-09-09 against `37c7ddf` plus the uncommitted changes. The complete dirty-diff artifact is `/tmp/patchdeck-ui-review/changes.patch`. The primary agent owns integration and this record.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS, 148 tests in 22 files | Editor delayed-save/retry/stale-response cases; Settings isolation and Mac shortcuts; appearance persistence/OS changes; visible diff markers; header drag routing |
| `npm run build` | PASS | TypeScript and Vite production build |
| `CARGO_TARGET_DIR=/tmp/patchdeck-review-20260909-target cargo test --locked` from `src-tauri` | PASS, 56 tests; 2 ignored | Separate cache avoids the pre-existing moved-directory artifacts |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `git diff --check`, `node --check scripts/local-app.mjs`, `sh -n scripts/local-runner.sh` | PASS | Formatting and launcher syntax |
| Native toolbar drag | PASS | Simulated header drag moved the Local window from x120/y120 to x180/y156, on the workspace and welcome screen |
| Native identity and production isolation | PASS | Local reports `Patchdeck Local` and `com.local.patchdeck.dev`; production stayed at PID 56762 throughout verification |
| Native Settings menu | PASS | `/tmp/patchdeck-ui-review/native-settings-final.png` shows the opened Settings panel |
| Live frontend update | PASS | Temporary welcome text appeared in the native app without a restart; restored afterward. `/tmp/patchdeck-ui-review/native-live-reload.png` |
| Rust rebuild lifecycle | PASS | Touching the Rust source replaced the Local process, leaving exactly one Local process and the unchanged production process |
| Quit, concurrent cold starts, and reopen | PASS | Quit removed the lock and stopped port 1420; two simultaneous launcher requests produced one Local process; closing and reopening retained that process |
| Browser light/dark layouts | PASS | 920 × 600 and 1280 × 800; five fixture recents fit at minimum size, with no horizontal overflow; forced scrolling keeps header y0/height64 |
| Browser appearance and modal focus | PASS | Light choice survives reload; closing Settings restores its button and removes inert state |

The regression tests for the save race and Settings shortcut escape failed against the original code before passing with the fixes. The temporary live-reload text and browser repository fixtures were removed after verification. Review-only subagent findings about launcher ownership were fixed and rereviewed.

## Unverified gaps

VoiceOver, Windows/Linux behavior, the standalone snapshot build, and release packaging were not tested. The two ignored Rust tests require a live Hermes installation. No agent runs, commits, publishing, or production updates were performed. Local and production app state are separate, but an explicitly opened repository remains the same working tree in both applications.

## Settings actions and Agent Board help follow-up

Requested on 2026-09-09: make Settings action buttons consistent and explain how the Agent Board works without Hermes and with supported coding providers.

- Settings action buttons share a 32 px height, 13 px text, padding, and icon sizing through one CSS rule reused by Providers, Execution Profiles, and Help. Navigation and profile selection cards retain their larger layouts. Narrow Settings panels stack provider cards and profile editing controls without horizontal overflow.
- Settings > Help covers Codex and Claude Code setup, profiles, card-only creation versus Create & run, conversations, stop/retry, manual lanes, local storage, and Hermes copies. Its shortcuts open Providers and Execution Profiles without starting a connection. Section changes reset the scroll position.
- Changed entries: `src/App.css`, `src/settings/SettingsPanel.tsx`, `src/settings/SettingsPanel.test.tsx`, and `src/settings/ExecutionProfilesSettings.tsx`.
- Passed: 44 focused tests in SettingsPanel and App; TypeScript/Vite production build; `git diff --check`. Browser measurements verified 32 px/13 px actions across Providers, profile creation/editing, and Help, with no horizontal overflow at 920 × 600 and 1280 × 800. Light and dark layouts were inspected. The new Help page was also opened in the running native Local app; evidence: `/tmp/patchdeck-ui-review/native-agent-help.png`.
- A read-only agent checked help claims against the actual local board and Rust provider flows. This follow-up did not launch coding agents or change provider connections. The full frontend and Rust suites were not rerun for this UI-only follow-up; their earlier results are recorded above.

## Compact workspace chrome follow-up

Requested on 2026-09-09: reduce the tall horizontal bars, then simplify their controls without adding padding. Owner: the primary coding agent.

- The title and comparison bars are 44 px, file/sidebar headers 40 px, and hunk/sidebar subheaders 28 px. The stack above the first diff line is 156 px, down from 227 px. Code typography and line spacing are unchanged. The shared `--toolbar-height` token also sizes the agent toolbar and anchors comparison errors below the bars.
- Branch labels sit beside their selectors. Selectors, project tabs, workspace switching, and review status use quieter treatments. Files/Commits use an underline; the file status reuses the existing compact StatusBadge. Viewed retains its checkbox, and Wrap retains its pressed state. Truncated branch names and file paths have native tooltips.
- Agent board navigation and lane headers are 36 px; its action toolbar is 44 px. No native window configuration or drag handler changed in this follow-up.
- Changed entries: `src/App.css`, `src/theme.css`, `src/localBoard/boards.css`, `src/components/DiffView.tsx`, `src/components/ProjectPane.tsx`, and the existing layout contract assertion.
- PASS: 60 tests across layoutContract, WorkspaceHeader, DiffView, AgentWorkspace, and App; TypeScript/Vite build; `git diff --check`. Browser checks used the real review components with temporary fixture data at 920 × 600 and 1280 × 800, in light and dark appearances. The measured bar heights matched the intended sizes, with no horizontal overflow in those rows. Wrap changed its pressed state, and Viewed remained operable. Temporary fixture files and records were removed.
- Native appearance was inspected in the running Local app. `/tmp/patchdeck-ui-review/compact-quiet-native.png` records the simplified dark layout. A native drag simulation moved the window to unexpected monitor coordinates, so that attempt is inconclusive; earlier native drag verification and the focused event-routing tests remain recorded above. Full Rust tests and live Hermes board checks were not rerun for this styling change.
