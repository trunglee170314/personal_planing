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
- [ ] Production rollout: back up then apply 0023, 0024, 0025 before deploying this UI. No new migration has been applied to production in this batch.
- [x] Four additional Goal colors: Rose, Coral, Lime, Slate; shared palette and cloud constraint expansion (0023 not applied in production).
- [x] Ctrl/Cmd+Z app Undo, preserving native text Undo; atomic before/after receipts and conflict checks for complex operations. Scope and retention documented in README; creation/permanent deletion and ancillary settings/comments are excluded.

## Verification and remaining gates

All changes are in the working tree, not a claim about the hosted production version. The final full regression run passed 140 tests in 21 files. SQLite uses in-memory fixtures and the PostgreSQL suite uses a network-isolated disposable test container, never user records. Final TypeScript and lint checks passed (zero warnings/errors); the approval-enabled cloud build and cloud-config verification passed. The restarted local web (`127.0.0.1:3000`) and database API (`127.0.0.1:4318/health`) both returned HTTP 200 from Windows. Browser visual testing has not been performed during this implementation pass.

Reviewer fixes include account-wide write serialization before row locks, CAS/conflict-safe Undo, recomputation of derived progress from current children, bounded receipts, cancellation of account-A reads after switching to B, settled reloads that cannot replace newer optimistic edits, atomic full-series saves, editor-open baselines, recurrence rule CAS, monthly completion-key remapping and distinct editor/list event sources. One saved series edit is one Undo command; failure rolls back the entire transaction.

The local server must restart to load the new API and SQLite schema. Cloud deployment needs SQL migrations 0023–0025 first; building the client alone is insufficient. Keep the existing push Alarms rollout gate separate. No production deploy, Git push or commit was performed for this batch.

Milestone remains a dated checkpoint (notes supported). Additional reminder/completion semantics were proposed, not explicitly confirmed. Group move confirmation must make checklist/milestone shifts explicit because the scope question was not answered. Middle/right mouse buttons never create or move items.

Previous rollout note: approvals enabled in production; Alarms activation still waits on operator webhook-secret setup, and must not be reported as activated.
