# September workspace improvements

Applies to cloud Supabase and local SQLite. Preserve existing data and parent-task indentation.

- [x] First fixes: merge moved occurrence state on completion; include moved exceptions at destination; left-button-only Calendar/Timeline creation; remove global 1240px width cap.
- [x] Regression tests for pointer guards, recurrence state, monthly/leap-year moves, atomic edits and Undo; dense Calendar lanes have a minimum width and horizontal scrolling.
- [x] Today checklists, including overdue unresolved occurrences, beside reminders.
- [x] Search throughout workspace and inside selectors; default tasks grouped Goal/checklists grouped Task; stable order after edits.
- [x] Durable comments for Tasks/Calendar items/Milestones, multiple links for Checklist/Reminder; owner isolation and quotas.
- [x] Task-bound milestones; flags above bars without permanent title, hover details/comments and collision levels.
- [x] Shared full Task/Goal editor in Timeline and Mindmap.
- [x] Timeline weekdays, weekend shading, configurable holidays; expanding history/future range and matching grid/header extent. Day columns rendered near the viewport, bounded to years 2000–2200.
- [x] Atomic group schedule moves with explicit affected-items confirmation; individual task move/reparent, no accidental sibling moves. Outline drops reparent without changing dates.
- [x] Mindmap sidebar under Timeline, Goal→Task→Checklist tree, pan/zoom/collapse and direct CRUD.
- [x] Page search/filter/sort and responsive height/width throughout workspace.
- [x] Notifications: graceful plain-text payload fallback and separate local-device/remote-push tests. Test acceptance is explicitly not a delivery confirmation.
- [x] Automated local and isolated PostgreSQL verification, TypeScript/lint checks and cloud build. One independent review agent; fixes incorporated.
- [ ] Visual/device acceptance on desktop and phone, including actual Windows/iPhone notification delivery.
- [x] Production rollout: private snapshot captured, then migrations 0023, 0024, 0025 applied before deploying the UI on 2026-09-03. See rollout verification below.
- [x] Four additional Goal colors: Rose, Coral, Lime, Slate; shared palette and cloud constraint expansion (0023 applied in production).
- [x] Ctrl/Cmd+Z app Undo, preserving native text Undo; atomic before/after receipts and conflict checks for complex operations. Scope and retention documented in README; creation/permanent deletion and ancillary settings/comments are excluded.

## Verification and remaining gates

The final full regression run passed 140 tests in 21 files. SQLite uses in-memory fixtures and the PostgreSQL suite uses a network-isolated disposable test container, never user records. Final TypeScript and lint checks passed (zero warnings/errors); the approval-enabled cloud build and cloud-config verification passed. The restarted local web (`127.0.0.1:3000`) and database API (`127.0.0.1:4318/health`) both returned HTTP 200 from Windows. Browser visual testing has not been performed during this implementation pass.

Reviewer fixes include account-wide write serialization before row locks, CAS/conflict-safe Undo, recomputation of derived progress from current children, bounded receipts, cancellation of account-A reads after switching to B, settled reloads that cannot replace newer optimistic edits, atomic full-series saves, editor-open baselines, recurrence rule CAS, monthly completion-key remapping and distinct editor/list event sources. One saved series edit is one Undo command; failure rolls back the entire transaction.

The local server must restart to load the new API and SQLite schema. A new cloud installation needs SQL migrations 0023–0025 before this UI; building the client alone is insufficient. These migrations are now installed on the existing production project: do not rerun them. Keep the existing push Alarms rollout gate separate. No Git push or commit was performed by the agent for this batch.

Milestone remains a dated checkpoint (notes supported). Additional reminder/completion semantics were proposed, not explicitly confirmed. Group move confirmation must make checklist/milestone shifts explicit because the scope question was not answered. Middle/right mouse buttons never create or move items.

Previous rollout note: approvals enabled in production; Alarms activation still waits on operator webhook-secret setup, and must not be reported as activated.

## Production rollout — 2026-09-03

- Existing site: https://myplan.trungvanle.workers.dev/ (Cloudflare Worker `myplan`).
- Deployed version: `d860fce7-61b3-4f65-97d8-2cf30ed269bf`.
- Supabase project: `hoilnhlipdzfylkzqnvw`; migrations 0023, 0024 and 0025 each committed successfully through its SQL Editor.
- Before migration, captured 26 public tables plus schema metadata at `2026-09-03 13:33:14.872552+00` in `myplan_rollout_backup_20260903.snapshot`. This is an operator-only, same-database snapshot, not an off-site backup or Auth backup. No snapshot content was exported or displayed.
- Verified all 20 new/replaced function bodies match the checked-in migration source by MD5 (normalized line endings); public RPC execution is denied to anonymous users, private functions are denied to authenticated and anonymous clients.
- Verified both new public tables have RLS, four owner/approval policies, and all 12 planning lock/capture triggers are present. Undo history and the backup schema are inaccessible to application clients. Goal, Task, Calendar and Milestone record counts match the pre-migration snapshot.
- Post-deployment checks: `/` and `/login` return HTTP 200 HTML; Supabase Auth is reachable. SHA-256 checks match 23 served assets to the validated local cloud build, including Calendar, authentication and the service worker.
- Production account approvals remain enabled. The push worker, queues and Alarms activation were not changed. Real Windows/iPhone delivery and visual/device acceptance remain unchecked above.
