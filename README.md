# The Plan

The Plan is a private personal-planning workspace built with React/Vinext. It connects goals, tasks, due dates, a timeline, weekly reviews, and an independent Pomodoro timer.

## Selected-date Checklists

In a Checklist editor, choose **Repeat → Selected dates**, set the shared start/end time, and use **Add date** for each desired day (up to 366 dates). One Checklist owns all dates and comments; Calendar shows a separate block on each date, with independent Done/Not needed. Open a block to edit that occurrence or choose **Edit entire series…** for shared fields. Once the series has occurrence history, its date pattern is protected; edit individual occurrences or create a new schedule instead. Whole-series moves and Undo retain the pattern and outcomes. Checklists must end within the same Vietnam day.

Online requires `supabase/migrations/0032_selected_date_checklists.sql` after migrations 0001–0031, before deploying this frontend. Local SQLite upgrades automatically on server restart; Local and Online data remain separate. Verification: `npm test -- tests/selected-dates.test.ts`; from WSL with Docker, `bash scripts/test-selected-dates.sh` verifies the migration, atomic create, progress, manual Task completion/reopen, moves, Undo, inherited Reminders, both push paths and ownership using a disposable network-isolated database. Never apply files under `tests/fixtures/` to live Supabase.

## Quick Task links

Use the ↗ button to open a Task's main HTTP/HTTPS link in a new tab from Tasks, Checklists, Today, Calendar (Day/Week/Month and the overflow list), Timeline, Mindmap, workspace search and command results. Checklists reuse their linked Task's URL; unavailable Tasks or invalid/empty URLs show no button. Task, Checklist and occurrence editors also offer **Open task link**. With the Timeline outline hidden, the link action stays at the visible start of each Task row. Clicking the title still edits; opening a link does not move, resize or complete anything.

Select a row and press `O` to open its Task link. Remap **Open selected Task link** in Settings → Keyboard shortcuts. This does not replace System Map's separate node-link shortcut and does not run while typing or inside a dialog. Local and Online use the same UI; no database migration is needed.

## Insights

Insights shows a Vietnam-time Monday–Sunday view of scheduled checklist occurrences. Done, Not needed and Open are separate; Overdue is a subset of Open. The performed rate is Done / Scheduled, never (Done + Not needed) / Scheduled. A repeat is counted once per displayed occurrence start in the selected week, including moved-in occurrences and excluding moved-out ones. Cross-midnight work belongs to the week in which it starts. Reminders and checklists linked to unavailable/cancelled Tasks are excluded.

Every overview count and By Goal count opens its underlying items. Recurring items open the occurrence-specific editor; Edit entire series is explicit. Drilldowns include safe Task links when present and load additional rows in batches. By Goal uses current Task–Goal links, groups unlinked work under No available Goal, and counts current parent and child Tasks separately; these counts are not Goal progress percentages.

Needs attention separates selected-week checklist outcomes from current Task alerts: overdue Tasks, Tasks due today through six days ahead without an open upcoming/ongoing checklist before the deadline, and work without an available Goal. Task deadlines are inclusive Vietnam dates. Alert lists may overlap and must not be added together. Historical weeks show current outcomes, not immutable snapshots; rescheduling, outcome changes and Goal-link edits can change earlier weeks. Planned durations are not reported as actual hours worked.

Today reuses its loaded workspace for a compact weekly summary. Reviews links the selected week to Insights and labels Task status separately from performed checklist outcomes. Background data refresh preserves unsaved Review text and satisfaction ratings. Insights is computed through the same shared projection in Local and Online modes; it stores no new counters and needs no SQL migration. Navigate with `G A`; `[` / `]` change weeks and `T` returns to this week. All navigation shortcuts can be remapped in Settings.

Verification: `npm test -- tests/insights.test.ts tests/calendar.test.ts tests/occurrence-state.test.ts tests/shortcuts.test.ts`. Repeat with `TZ=America/New_York` to check Vietnam week boundaries and DST-safe recurrence identities.

## Important milestones

In a milestone's editor, enable **★ Important** to show a larger star, a high-contrast outline and an always-visible short title on Timeline. The chosen milestone color is retained. Hover or focus for the full title and date. Marker labels are capped at 220 px and overlapping markers use separate lanes at every zoom level. **Important only** filters milestone markers, not Task/Goal bars or stored records; turn it off to show Normal milestones again. Existing milestones remain Normal until explicitly marked Important. This metadata does not change dates, progress, parent relations or notifications and saved importance edits support Undo.

Online deployment requires `0031_important_milestones.sql` after migrations 0001–0030. Apply it before deploying the new frontend. It adds one boolean column with a Normal default and leaves account isolation and Undo capture in place. Local databases upgrade automatically on server restart. Verification: `npm test -- tests/important-milestones.test.ts tests/workspace-extras.test.ts tests/timeline-commands.test.ts`. From WSL, `bash scripts/test-important-milestones.sh` also checks PostgreSQL defaults, migration idempotency, Undo, group moves and owner isolation in a fresh network-isolated disposable Docker database; it never connects to live Supabase.

## System Map

System Map is a separate freeform canvas; Mindmap still displays Goal → Task → Checklist. Use **New Map** to create a canvas, then right-click blank space for **Add Node / Add Group**. On touchscreens, hold blank space. Add Group enters drawing mode: drag a rectangle and name it. Drag a node to move it, a group header to move the group and its nodes, and the selected group's handles to resize. Double-click a header (or use its popup) to collapse/expand. Drag a node's connection port to another node, then select the connection to choose Solid/Dashed and No arrow/One-way/Two-way. Keyboard users can select nodes and connection paths; a port also supports choosing a target with its **Connect here** button.

Each mutation saves automatically with a version check. A conflict or failed save preserves the draft, disables further writes, and offers **Download unsaved map** and **Reload**. Maps are private per Online account, and stored in SQLite in Local mode. History keeps the last 50 snapshots; repeated layout moves within five minutes share a snapshot. Restoring a snapshot adds a new version. Deleted maps retain their history in Trash for 30 days; expired Trash is cleaned when listing/mutating maps, and permanent deletion is available after confirmation. Local map data is included in existing SQLite backups.

Node cards size to their title (140–380 px wide), wrapping long text without ellipsis. Geometry is persisted so other devices use the same bounds. Existing maps acquire explicit dimensions when opened and persist them on the next successful edit; old History snapshots are not rewritten. A map already at its group/document limit retains safe legacy bounds and shows a warning instead of silently detaching nodes.

Use `N` for a new node, `Ctrl/Cmd+Enter` for a connected child to the right, and `Shift+Enter` for a nearby node below. Repeated children share a column and avoid existing cards. **Auto layout → Arrange branch → Right** (`Shift+J`) rearranges only the selected root's directed branch, leaving the root, unrelated/shared nodes and pinned positions untouched. Grid/Circle arrange the whole map. Select multiple nodes to align edges/centers or distribute them with equal gaps; overlapping alignments are rejected without modifying the map. **Keep position** (`Shift+P`) excludes selected nodes from automatic layout but still permits manual dragging. Dragging shows alignment guides; hold `Alt` to bypass snapping. All shortcuts can be remapped in Keyboard shortcuts.

Search keeps the map visible: nonmatching nodes and unrelated connections fade, while matching names receive an amber text highlight and card glow. Description-only matches receive the glow. Hovering, focusing or selecting a faded node restores its visibility. Use Enter/Shift+Enter in Search or F3/Alt+F3 to cycle results, and **Fit results** (`Shift+F`) to frame them. Search does not restrict selection, snapping, navigation or layout. Collapsed groups remain collapsed.

Limits per map: 1,000 nodes, 40 groups, 3,000 connections, 4 MiB; up to 50 maps including Trash. Map entities count toward Online workspace record limits; recovery snapshots have their own bounded retention. Online deployments must apply **`0027_system_maps.sql`** after migrations 0001–0026. Local databases create the new tables automatically on startup. The display name is now **The Plan**; legacy storage keys, database paths, RPCs, and deployment URLs remain compatible. Logo assets are a separate design task.

Before deploying this System Map UI online, apply **`0029_system_map_node_geometry.sql`** followed by **`0030_system_map_scale.sql`** after `0027`/`0028`. These change validation only, retaining schema-1 legacy dimensions, account isolation, version checks, quotas and History; they do not rewrite user data. Building the frontend does not apply SQL migrations. Local mode uses the shared validator and needs only a server restart, not a separate SQL migration. Large maps render only cards and connections intersecting the viewport; overview zoom uses simplified cards, without removing records from the document.

Timeline parent tasks have a separate caret to collapse all descendants. Clicking the title still opens Edit. Collapse changes view state only, never dates, progress or parent relations. Timeline search temporarily expands branches; clearing it restores the previous collapse state.

Geometry verification: `npm test -- tests/system-map-geometry.test.ts tests/system-maps.test.ts tests/system-map-commands.test.ts`. For the PostgreSQL migration/CAS/History/access regression checks, run `bash scripts/test-system-map-geometry.sh` from WSL with Docker available; it creates and removes its own network-isolated disposable PostgreSQL container and never accesses the live Supabase database.

### Opt-in scale benchmarks

The scale benchmark tests 200, 500 and 1,000 synthetic nodes in disposable databases. It does not change real local data or the hosted deployment.

```bash
MYPLAN_SCALE_BENCHMARK=1 MYPLAN_BENCHMARK_OUTPUT=/tmp/myplan-scale-results.json npm test -- tests/system-map-scale.test.ts
bash scripts/benchmark-system-map-postgres.sh
```

The first command checks CPU geometry operations, temporary SQLite saves, snapshot restoration, Undo/Redo-style saves, stale-version rejection, and 50-snapshot retention. The PostgreSQL command needs Node and Docker in WSL; it creates and removes its own network-isolated container and tests migration 0030. Set `MYPLAN_BENCHMARK_VALIDATOR=legacy` to compare the previous validator with temporary benchmark-only caps. It measures validation and public command function execution, not Internet latency or the live Supabase service. `MYPLAN_BENCH_NODE` can select another Node executable if it is not on the WSL PATH.

Timings depend on hardware, payloads, topology and build mode. Browser profiling must use a separate disposable checkout/database. Passing storage tests alone does not establish smooth large-map interaction or mobile performance.

The same interface has two deliberately separate data modes:

- **Local:** a SQLite file on the laptop, no Internet and no sign-in required.
- **Cloud:** Supabase Auth/Postgres for use from the hosted website, laptops, and phones.

Local and cloud records are independent in the current version. There is no automatic synchronization, merge, or fallback between them.

## What currently works

- SQLite local-only workspace with no cloud dependency.
- Supabase self-registration, email/password authentication, email confirmation, and password recovery in cloud mode.
- Today dashboard with separate overdue/today Checklist and Reminder cards and a resizable Day/Week time grid.
- Goal creation/editing, twelve persistent Goal colors, Task-derived progress and completion, archive/restore, recoverable Trash, and confirmed permanent deletion.
- Task creation/editing, link, priority, start/deadline, Goal, parent Task, dependency, status, archive/restore, recoverable Trash, and confirmed permanent deletion.
- Google Calendar-style Day/Week/Month planning from 00:00–24:00: drag empty time to add a Task-linked Checklist or standalone Reminder, exact time input, 15-minute snapping, recurrence, per-occurrence completion, move/resize, and overlapping items.
- Goal → Task → optional Subtask Gantt with Week/Month/Quarter/Year zoom, today line, Task-derived progress, drag-created milestones, dependency warnings, live drag/resize preview, and one save on pointer release.
- Mindmap under Timeline: Goal → Task → Checklist, with direct add/edit/remove, collapse and pan/zoom.
- Search across sections and inside relation selectors; stable default Task-by-Goal and Checklist-by-Task ordering. Timeline weekdays, weekend shading and custom holidays are available in Settings.
- Bulk import from an Excel workbook, CSV/TSV file, or a table pasted from Excel/Google Sheets. One batch can create or update Goals, Tasks, Checklists, Reminders, Milestones, links, and comments in either Local or Cloud mode.
- Task/Checklist/Reminder/Milestone comments, multiple Checklist/Reminder links, Task-bound milestone flags, and full Goal/Task editors from Timeline.
- Ctrl/Cmd+Z (or the Undo button) for saved planning edits, completion changes and schedule moves; see the scope below.
- Weekly reviews stored in the selected local or cloud database.
- Five visual themes persisted per cloud account or in the local laptop database.
- Independent Pomodoro timer with configurable breaks, daily session/minute targets, persistent completed-session history, and device-local active-timer recovery.

Cloud mode supports per-device background Web Push for Checklist and Reminder notifications, including installed iPhone Home Screen apps. Automatic local/cloud synchronization, advanced multi-step dependency graphs, and configurable workflows are not complete yet.

## Prerequisites

- Git.
- Node.js `22.13.0` or newer.
- npm `9` or newer.
- A Supabase account and project only when cloud mode is needed.
- WSL 2 with Ubuntu is recommended on Windows, but Linux and macOS also work.

Verify the runtime before installing anything:

```bash
node --version
npm --version
```

`nvm` is optional and is not installed automatically with Node.js. If `node --version`
already reports `v22.13.0` or newer, skip the following commands. If Node.js is too
old and you have installed `nvm` separately, switch versions with:

```bash
nvm install 22
nvm use 22
```

If the shell reports `nvm: command not found`, either continue with the existing
Node.js installation when it already meets the required version, or install NVM
from the official [`nvm-sh/nvm`](https://github.com/nvm-sh/nvm) instructions and
open a new terminal before running the commands above.

## 1. Clone and install

```bash
git clone https://github.com/trunglee170314/personal_planing.git
cd personal_planing
npm ci
```

When opening an existing Windows checkout from WSL, quote paths that contain spaces:

```bash
cd "/mnt/c/Users/<WINDOWS_USERNAME>/Documents/personal_planing"
npm ci
```

The underscore in `personal_planing` does not need escaping.

`npm ci` installs the exact versions in `package-lock.json`, including the local `vinext` executable. Run it after every fresh clone and whenever the lockfile changes.

> Installing dependencies under `/mnt/c` can be much slower than using the WSL Linux filesystem. For faster installs and hot reload, clone under a directory such as `~/projects/personal_planing`.

## 2. Create and prepare Supabase for cloud mode

Create a Supabase project for this myplan instance and wait until its database is ready.

For a **new, empty Supabase project**, open **SQL Editor**, paste the complete contents of `supabase/bootstrap_current.sql`, run it once, and confirm that it succeeds. This is the canonical clean-install schema used by the current application, including account isolation, Calendar recurrence state, Timeline milestones, Pomodoro, reviews, and user bootstrap.

`bootstrap_current.sql` includes migrations through `0018`. For a new project, run the complete migrations `0019` through `0030` in filename order after bootstrap. For an existing project, apply only migrations not already installed; do not rerun bootstrap or migrations `0001`–`0018`. Run each complete file as a separate query and back up production first. Migration `0021` enables account approval; follow [access rollout](docs/access-and-push-rollout.md) to provision your verified administrator.

The current UI also requires `0026_timeline_order_colors_and_legacy_delete.sql` before cloud deployment. It persists Timeline ordering and Milestone colors and safely detaches legacy Focus history during permanent removal. Local SQLite upgrades automatically when its server restarts. New cloud migrations are **not applied by building the frontend**. Applying `0022` does not itself activate Durable Object Alarms; its separate rollout gate still applies.

Apply `0028_fix_timeline_reorder_position.sql` to fix vertical Timeline drag/reorder on upgraded databases that retain the legacy `tasks.position` column. It replaces only the reorder function, preserving ownership checks and Undo support; it does not delete user data. Frontend deployment alone cannot fix this SQL error. Local SQLite does not need this migration.

### Bulk import

Open **Import** in the workspace sidebar and download the Excel template. Its separate sheets describe Goals, Tasks, Checklists, Reminders, Milestones, and Links & Comments. Keep each `Key` unique and reuse it in relation columns such as `Goal key`, `Task key`, and `Target key`. Checklist rows support date, start/end time, all-day mode, recurrence, repeat interval/end date, notification offsets, completion state, pinning, links, and comments.

The preview validates row values and relationships against both the workbook and the current workspace before anything is saved. Choose whether matching items are skipped, updated, or created as duplicates. A batch is limited to 300 source rows and 400 KB of normalized data so its Undo receipt remains bounded; split larger imports into multiple files. A successful batch is one Ctrl/Cmd+Z operation. If a row fails while saving, myplan attempts to roll back the partial batch automatically.

The importer uses the currently selected data mode. Local imports stay in the laptop SQLite database; Cloud imports stay in the signed-in Supabase account. Import does not synchronize or copy records between those databases.

### Undo scope

Ctrl+Z on Windows/Linux, Cmd+Z on macOS, or the workspace Undo button restores the last supported planning edit. Text fields keep their native text Undo. Supported actions include Goal/Task edits, archive/Trash status changes, Checklist/Reminder edits and completion, individual occurrence changes, recurring-series moves, milestone edits, whole Goal-group moves and Task reparenting. A full series save (dates plus metadata) is one Undo command.

History is limited to 20 commands in the current browser session; it resets on reload/account switch. Local history also resets when the local server restarts. Ordinary creation, permanent deletion, comments/links, holidays, theme settings, Pomodoro and Reviews are not undoable in this version and clear older history to avoid undoing an unrelated action. Bulk import is the exception: all supported rows in one successful batch share one Undo command. There is no Redo shortcut yet.

Undo refuses conflicting changes rather than overwriting a newer edit from another device. Receipts have a one-day lazy expiry, a 1 MiB/2,000-row per-command cap and a 2 MiB owner/local-server retention cap. An oversized command can save successfully without an Undo receipt; the UI explicitly says so and clears earlier history. Database backups remain necessary—Undo is not a backup.

After all migrations have succeeded:

1. Open **Authentication → URL Configuration**.
2. Set the Site URL to the production origin, for example `https://myplan.trungvanle.workers.dev`.
3. Add the production origin and development origins to the allowed redirect URLs:
   - `https://myplan.trungvanle.workers.dev/**`
   - `http://localhost:3000/**`
   - `http://127.0.0.1:3000/**`
4. Under **Authentication → Sign In / Providers → Email**, enable email sign-up.
5. Keep email confirmation enabled so a visitor must prove ownership of the address before entering the workspace.

Each person can then create a separate account at `/register`. Row Level Security isolates goals, tasks, calendar entries, reviews, and settings by authenticated user ID.

Supabase's built-in email sender is intended for trial use and has a low delivery rate limit. Configure a custom SMTP provider under **Authentication → Emails → SMTP Settings** before sharing the site broadly; otherwise confirmation and password-recovery messages may be delayed or rejected when several people register close together.

## 3. Configure local environment variables

Create a local environment file from the committed template:

```bash
cp .env.example .env.local
```

In Supabase, open **Project Settings → API** and copy the Project URL and publishable key into `.env.local`:

```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_MODE=cloud
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your-vapid-public-key
```

Only these public browser values are required. Do not add a Supabase service-role key to this frontend project. Never commit `.env.local` or any secret.

Restart the development server whenever an environment value changes.

### Background Web Push worker

The scheduled sender is a separate Cloudflare Worker. Configure its encrypted
secrets; never put the service-role key or VAPID private key in a `NEXT_PUBLIC_*`
variable or commit them:

```bash
npx wrangler secret put SUPABASE_URL --config push-worker/wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config push-worker/wrangler.jsonc
npx wrangler secret put VAPID_PUBLIC_KEY --config push-worker/wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config push-worker/wrangler.jsonc
npx wrangler secret put VAPID_SUBJECT --config push-worker/wrangler.jsonc
npm run deploy:push
```

Use the same VAPID public key in the app and worker. `VAPID_SUBJECT` may be the
production HTTPS origin. The cron in `push-worker/wrangler.jsonc` checks due
notifications once per minute; delivery rows prevent duplicate alerts.

## 4. Run cloud mode during development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Existing users can sign in at `/login`, and new users can create their own account at `/register`. Stop the server with `Ctrl+C`.

If the terminal prints a different local URL because port 3000 is busy, open the exact URL shown by Vinext and add that origin to the Supabase redirect allowlist.

## 5. Run the laptop-only local mode

Local mode uses Node's built-in SQLite support. It does not require Docker, a Supabase account, or Internet after dependencies have been installed.

```bash
npm run dev:local
```

Open [http://localhost:3000](http://localhost:3000). A **Local** badge identifies this mode and the Supabase login screen is skipped.

The database is created outside the Git repository at:

```text
~/.local/share/myplan/myplan.db
```

Override the location only when necessary:

```bash
MYPLAN_LOCAL_DB_PATH="$HOME/myplan-data/myplan.db" npm run dev:local
```

The local API binds only to `127.0.0.1:4318`, accepts the two exact web origins on port `3000`, and uses a new private startup token for each run. It is not available to other devices. Port `3000` must be free in local mode. Stop both the website and database with `Ctrl+C`.

### Local database backup and restore

Local mode now automatically makes **one verified backup per calendar day** while the local API is running. It checks immediately at startup and every 15 minutes, so a missed day is caught up on the next start/resume. It does not wake a sleeping computer or run while the local server is stopped. Manual backups made today also satisfy the daily check. Calendar days follow the operating system's timezone.

Backups use SQLite `VACUUM INTO`, which captures a consistent snapshot including committed WAL data while the app stays usable. The work runs in a separate process. Each snapshot is checked with SQLite `integrity_check` and a myplan schema check, then saved with a timestamp and a SHA-256 checksum in a companion `.json` file. A failed attempt is not marked successful and does not prune previous backups; automatic failures are logged and retried at the next check. Copying only a live `myplan.db` with Explorer/`cp` is **not** a safe backup because recent data may still be in `myplan.db-wal`.

Default backup folders (outside the source checkout):

- **Windows + WSL:** `C:\Users\YOUR_WINDOWS_USER\myplan-backups\myplan-<database-id>\` (seen from WSL as `/mnt/c/Users/YOUR_WINDOWS_USER/myplan-backups/...`). Windows profile detection uses WSL interop; if it is unavailable, configure an explicit path below. It will not silently store the backup inside WSL instead.
- **Native Windows:** `<Windows user profile>\myplan-backups\myplan-<database-id>\`.
- **Native Linux/macOS:** `~/myplan-backups/myplan-<database-id>/`.

The database ID isolates different source database paths/distributions. The **30 newest ordinary snapshots** (automatic and manual combined) are retained per database. Older recognized snapshots are removed only after a new verified backup succeeds. **Pre-restore safety backups are excluded from automatic cleanup**; manage these yourself after confirming the restore. Files belonging to other databases or unrecognized/modified files are left alone.

To choose another folder, add this to `.env.local` and restart local mode. It must be an absolute path as seen by Node, outside the source checkout. In WSL, use a `/mnt/c/...` path rather than `C:\...`:

```dotenv
MYPLAN_BACKUP_DIR="/mnt/c/Users/YOUR_WINDOWS_USER/myplan-backups"
```

`MYPLAN_LOCAL_DB_PATH` and `MYPLAN_BACKUP_DIR` are read from `.env.local` by the local launcher and data commands; existing shell environment values take precedence. Empty values use defaults. The live database location does not change when you change the backup folder. Point only **finished backups**, not the live database, at a cloud-sync folder. These files contain your private planning data and are not encrypted by this feature. A second copy on another device/drive or a cloud destination you select is needed to protect against loss of the computer/drive. This does not back up the online Supabase database or synchronize online/offline data.

Run the following in a **WSL terminal opened in this repository**, using the same distribution/user and environment as local mode. They also work in a native Node installation if that is where your database is hosted. Running them with Windows Node when the app runs in WSL targets a different database.

```bash
# Show the exact database/backup paths and available snapshots
npm run data:local -- list

# Back up now; local mode may remain running
npm run backup:local

# Verify a specific snapshot (keep its .json checksum file next to it)
npm run data:local -- verify "/mnt/c/Users/YOUR_WINDOWS_USER/myplan-backups/myplan-DATABASE_ID/SNAPSHOT.db"
```

To restore, **stop local mode first**. For a foreground server use `Ctrl+C`. For autostart/background mode, run the graceful stop command below; it stops only this myplan database's server and lets its launcher exit successfully without triggering Task Scheduler retries. It does not disable future logon autostart or stop other WSL applications.

```bash
npm run stop:local
npm run restore:local -- "/mnt/c/Users/YOUR_WINDOWS_USER/myplan-backups/myplan-DATABASE_ID/SNAPSHOT.db" --confirm
```

Restore refuses an active database, missing confirmation, corrupt/incompatible input, a checksum mismatch, or an unsafe WAL state. It creates and verifies a separate **pre-restore backup of the current data before replacement**. If that safety backup cannot be saved, restore stops without replacing your database. The verified replacement is staged beside the database and atomically renamed into place. A restore replaces the entire local database; it does not merge records. The source snapshot is left unchanged. Restoring into a new database path is supported and has no previous data to save. Older snapshots without a checksum file still receive integrity/schema checks, but cannot be checked against their original checksum.

Start again with `npm run dev:local`, or run `schtasks /Run /TN "myplan-local"` from **Windows CMD/PowerShell** if you use autostart. On another machine, install/update the whole source, copy the snapshot **and its `.json` file**, configure the destination paths there, and run the same restore command. Do not copy the SQLite maintenance lock files or the private runtime control file as backups.

The background log `~/.local/state/myplan/startup.log` records `BACKUP OK`, backup paths, and failures. For a manual foreground run, these appear in its terminal. No cloud account or Internet connection is required to create or restore these local snapshots. Updating source/Git alone does not back up your database.

### Start local mode automatically with Windows and WSL

First confirm that `npm run dev:local` works manually inside your default WSL distribution. Then open **Command Prompt (CMD) or Windows PowerShell** in the repository and run this one-time registration command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-windows-autostart.ps1
```

Wait for the script to print `Registered 'myplan-local'`. This registers a persistent Scheduled Task for the current Windows user. After each Windows sign-in, the task waits 30 seconds, then starts the local website through a **hidden Windows launcher and WSL, without opening a terminal**. It runs **after signing in**, not merely after powering on the computer. The task also runs on battery power, stays running when unplugged, and can run a missed logon trigger when available.

Once registered and working, you do not need to run a command every day. Sign in to Windows, wait for startup, and open [http://localhost:3000](http://localhost:3000). Neither a terminal nor the browser should open automatically. Local mode does not require Internet after the dependencies have been installed.

The task uses your default WSL distribution. Install Node.js 22.13+ and the project dependencies there first. Paths containing spaces are supported. Keep the repository in the same location; if you move it or update the registration script, run the registration command again to update the task.

**Upgrading an existing setup:** update the whole source checkout (including the new `start-local-windows.ps1`, `status-local-windows.ps1`, and `local-startup.mjs` files), not only this README or the registration script. Run the registration command again. When replacing the old direct-WSL task, restart Windows once and sign in to avoid leaving the previous server running. Updating files on another computer does not update this computer or its Scheduled Task.

#### Run immediately without signing out

Stop any manually running local server first. In **CMD or PowerShell**, run:

```cmd
schtasks /Run /TN "myplan-local"
```

Alternatively, in **PowerShell only**, run:

```powershell
Start-ScheduledTask -TaskName myplan-local
```

These commands only start the already-registered task now; they do not register autostart and do not need to be repeated after future sign-ins. Allow time for the server to start, then open [http://localhost:3000](http://localhost:3000). A `SUCCESS` response from `schtasks /Run` means the start request was accepted, not that the website is ready.

#### Check whether the website is ready

In the repository, run this command from **CMD or PowerShell**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\status-local-windows.ps1
```

This prints the task's state, last run/result, battery setting, and checks the actual webpage **from Windows**. `READY` means the webpage returned HTTP 200. `NOT READY` means it did not respond successfully within 10 seconds; the report includes available launcher diagnostics. `Running` by itself only means the launcher is alive. This command checks status; it does not start the task.

The 30-second logon delay is **not** the total startup time. A cold WSL start and Vite's first-page compilation may take longer, especially for a checkout on a Windows drive. The launcher warms the first page automatically and writes `READY: http://localhost:3000/ returned HTTP 200` only after the database API and webpage respond. While starting it logs `Waiting for web readiness (...)` every 15 seconds. If the web server is still not ready after five minutes, it stops that attempt's child processes and exits with an error; Task Scheduler can retry up to three times with a one-minute interval. Failures are logged instead of waiting silently forever.

#### If localhost does not open

- If CMD reports `'Start-ScheduledTask' is not recognized`, use the `schtasks /Run` command above or open PowerShell. `Start-ScheduledTask` is not a CMD command.
- If the task cannot be found, run the one-time registration command first and check that it prints `Registered 'myplan-local'`.
- If an older checkout reports `wslpath: C:Users...` followed by a `.Trim()` null error, update `scripts/register-windows-autostart.ps1` and register again. The script must invoke `wsl.exe --exec wslpath`, not `wsl.exe -- wslpath`, so Windows path separators are preserved.
- If a blank terminal still opens automatically, the old task action is probably still registered. Update the full checkout, register again, and restart Windows once. The new action uses `powershell.exe -WindowStyle Hidden` and starts WSL without a console window; hiding a task in Task Scheduler alone is not sufficient.
- If the status report says `Run on battery: False`, re-register with the current script; the older task's default battery conditions can prevent startup or stop the server when unplugged.
- If the log reports `EADDRINUSE`, another process already owns port 3000 or the local API port. Stop the previous local instance before trying again. The web server deliberately does not silently switch to port 3001.

Check the task's status and last run result from **CMD or PowerShell**:

```cmd
schtasks /Query /TN "myplan-local" /V /FO LIST
```

Read the latest startup log from **CMD or PowerShell**:

```cmd
wsl.exe --exec bash -lc "tail -n 50 ~/.local/state/myplan/startup.log"
```

The background log is stored inside WSL at:

```text
~/.local/state/myplan/startup.log
```

Each attempt now starts with a timestamped `START myplan local` line and logs its exit status. Compare the newest attempt's timestamp with the last task run; old `Local:` or `GET / 200` lines from before a restart do not prove the current server is ready. `Tunnel closed` is a Cloudflare development-tool cleanup message, not an explanation of why the process stopped.

If WSL itself cannot launch, read the **Windows launcher log**, which is separate from the web log. In PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\myplan\autostart.log" -Tail 40
```

Or in CMD:

```cmd
type "%LOCALAPPDATA%\myplan\autostart.log"
```

If the web log does not exist, startup may have failed before reaching Bash. The Windows log records when WSL was launched and its exit code/output when it stops. The Bash log also captures setup failures such as missing Node.js/npm or dependencies. Confirm that the default WSL distribution starts and that `npm run dev:local` works manually inside the repository there. For troubleshooting, send the status report and the latest timestamped attempt from both logs.

To remove automatic startup, run in Windows PowerShell:

```powershell
Unregister-ScheduledTask -TaskName myplan-local -Confirm:$false
```

## 6. Validate a fresh checkout

Run all checks before opening a pull request or publishing:

```bash
npm test
npm run lint
npm run build
```

Expected result:

- Vitest passes Pomodoro, calendar, local API, and isolated SQLite/backup tests, including WAL snapshots, daily catch-up, retention, corrupt inputs, pre-restore safety, crash recovery, and automatic backup/stop/restore/restart.
- Oxlint reports no product-source errors.
- Vinext creates the production output under `dist/`.

On Windows, also check the autostart registration script without creating a Scheduled Task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-autostart.test.ps1
```

With WSL installed, verify the hidden launcher against a temporary fixture (no Scheduled Task or app server is started):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-autostart-wsl.test.ps1
```

For a real local-server smoke test, stop existing local servers so ports 3000 and 4318 are free, then run inside WSL:

```bash
node tests/local-launcher-smoke.mjs
```

This uses a temporary SQLite database and backup folder, waits for the real webpage, checks that a duplicate launch cannot disturb it, then uses `stop:local` and verifies successful launcher exit and release of both ports. It does not use your personal database. To additionally exercise backups on a mounted Windows drive, run the isolated integration test with `MYPLAN_BACKUP_TEST_ROOT` set to an existing Windows temp folder as seen by WSL; the test creates/removes only its own unique temporary subdirectories there.

To serve the built Worker locally:

```bash
npm run build
npm run start
```

## Troubleshooting

### Timeline drag shows `column reference "position" is ambiguous`

In the production project's Supabase SQL Editor, run the complete `supabase/migrations/0028_fix_timeline_reorder_position.sql` file after `0026` is installed. Verify the project reference matches the deployed website before running it. Do not rerun bootstrap or switch to an older project to work around missing account access.

For the PostgreSQL regression test in WSL, use a disposable `postgres:16-alpine` container named `myplan-workspace-test-20260903`, with `--network none` and no published ports. Run `bash scripts/test-timeline-reorder.sh --before-fix` to reproduce the original ambiguity and `bash scripts/test-timeline-reorder.sh` to verify the fix, Undo, cross-Goal/Inbox moves and owner isolation. These tests create fake data in new isolated databases, never in Supabase or your local SQLite database.

### `vinext: not found`

Dependencies are missing or incomplete. From the repository root, run:

```bash
npm ci
npm run dev
```

Do not install Vinext globally.

### The app says Supabase setup is required

This is expected only in cloud mode. Check that `.env.local` exists, `NEXT_PUBLIC_APP_MODE=cloud`, the Supabase URL/key are filled in, and the development server was restarted after editing it. Use `npm run dev:local` for the laptop database instead of removing Supabase values.

### Local mode cannot connect to the database

Run `npm run dev:local` rather than starting Vinext separately. The command starts both the loopback-only SQLite API and the website. If port `4318` is already in use, stop the older myplan process before starting another one.

### Local mode shows different data from the online site

This is intentional. SQLite data on the laptop and Supabase cloud data are separate. Automatic synchronization has not been implemented.

### Sign-in succeeds but tasks report that the workflow is unavailable

The Auth user was probably created before `0002_user_bootstrap.sql` ran. For a new development project, apply all migrations first and then recreate the test user. Do not recreate a production user without exporting or reviewing its data first.

### Password recovery returns to the wrong site

Add the current local or production origin to the Supabase Site URL and redirect allowlist. `NEXT_PUBLIC_SITE_URL` must use that same origin.

### Registration says the email rate limit was exceeded

The default Supabase email service has a low project-wide limit. Wait for the limit to reset or configure a custom SMTP provider under **Authentication → Emails → SMTP Settings**. This affects confirmation and recovery email delivery, not the account-isolation database rules.

### Installation or hot reload is very slow in WSL

Windows-mounted paths such as `/mnt/c/...` have slower filesystem operations. Clone the repository under the WSL filesystem, for example `~/projects/personal_planing`.

### npm reports dependency vulnerabilities

Review them with `npm audit`. Do not run `npm audit fix --force` blindly because it can install breaking major versions; update and test affected packages deliberately.

## Deployment notes

Online account approval, quotas, and the new alarm/queue notification scheduler
require a staged database-and-Worker rollout. See
[Access and push rollout](docs/access-and-push-rollout.md) before enabling
`NEXT_PUBLIC_ACCESS_APPROVALS_ENABLED`. Local/offline mode does not require approval.

The repository contains `.openai/hosting.json`, while the current production target is the configured Cloudflare Worker. Hosted Supabase values must be configured as deployment environment values; they do not come from `.env.local`.

To deploy the cloud build to the configured Cloudflare Worker, first authenticate
Wrangler for the `trungvanle` account, then run:

```bash
npm run deploy:cloudflare
```

The deployment command is intentionally locked to Supabase project
`hoilnhlipdzfylkzqnvw`. It validates the URL and publishable key before building,
calls the Supabase Auth settings endpoint to reject invalid or truncated keys,
then scans the generated bundle and refuses to deploy if it contains the retired
project reference. It also checks both `/` and `/login` after publishing. Keep
`.env.local` pointed at this same project when working in cloud mode.

This builds in cloud mode and publishes the Worker named `myplan` at
`https://myplan.trungvanle.workers.dev`. The account's Workers subdomain must be
`trungvanle`; Wrangler reports the actual deployment URL after publishing.

Every owner deployment should point to its own Supabase project. The browser must never select a database from user-provided identity data.

## Project structure

- `app/`: authentication and product modules.
- `components/ui/`: generated reusable UI primitives.
- `lib/data/`: common local/cloud data contract and adapters.
- `lib/supabase/`: browser-side Supabase client for cloud mode.
- `local-server/`: loopback-only SQLite database and HTTP API.
- `scripts/`: local launcher and Windows/WSL automatic-start registration.
- `lib/pomodoro.ts`: timestamp-based timer state transitions.
- `supabase/bootstrap_current.sql`: canonical schema for a fresh cloud project.
- `supabase/migrations/`: incremental upgrade history for existing cloud projects, currently through `0028`.
- `tests/`: Vitest tests.
- `docs/product-spec.txt`: complete product requirements.
- `docs/architecture.md`: deployment and data-isolation decisions.
- `.openai/hosting.json`: OpenAI Sites project metadata.
