# Calendar and Today verification

Reviewed on 2026-11-19. Baseline: `6291eee7663ddbb47090448244338f0bf175f017`.

Final frozen-source verification: **588 tests passed, 1 skipped** across 49
passing test files; TypeScript, lint of all 13 changed JS/TS files and the
production cloud build passed. Architecture and code reviews have no remaining
source blockers. Production migration/deployment requires an authenticated
Supabase project session; no authenticated production mutations were used as QA.

## Reported failure and resolution

After a recurring drag/resize, Entire series updated only the base session in the
Calendar's optimistic state. Materialized instances and existing overrides still
used their old values, and the source consumer ignored its own refresh event.
The database could correctly move the entire series while the visible Calendar
retained stale instances. Reloading only selected-date schedules missed this case.

All recurring move scopes now await the write and then read the canonical
workspace through the shared mutation lane. The chart stays frozen during the
save and never shows a base-only approximation of a materialized series. A saved
move followed by a read failure is reported separately from a failed write.
Calendar, Today and shared editors reject superseded or post-unmount reads, and
retry a stale read even when its overlapping mutation already finished.

Time-only occurrence moves retain current server outcomes instead of replaying
Done/Not needed copied before the scope dialog opened. Migration 0034 implements
this inside the approved-account and entry locks; missing states inherit the
current base outcome, while existing explicit Open states remain Open. Local
validates the merged override pair before writing and rolls back a whole batch
if a later move is invalid. Existing state IDs, notes and Undo capture remain.

Today and shared editors use bounded original-identity projection, preserving
long-running schedules, long legacy durations and exceptions moved before the
base date. Shared editor metadata changes retain pin settings. At Vietnam
midnight, Today follows the new day when its embedded Calendar was still on the
previous Today; deliberately selected other dates remain selected.

## Verification matrix

| Area | Evidence |
| --- | --- |
| Whole-series drag | Native Week drag changed all seven materialized daily instances immediately; a fresh read of the disposable SQLite database confirmed all seven stored times. |
| Scope boundaries | Native This occurrence changed only Wednesday; This and future changed Wednesday–Sunday and retained Monday/Tuesday. Retested after all scopes used canonical reads. |
| Resize and cancellation | Native start-handle and end-handle resizing, scope selection, cancellation and Undo restored the expected times. |
| Calendar/Today sync | Native drag in the embedded Today Calendar refreshed both its blocks and the overdue/current list; switching surfaces and reloading retained saved times. |
| Editing and pin | Native title edit through Today shared editor retained a pinned Reminder, confirmed in disposable SQLite; tests cover entire/following edits and notification fields. |
| Outcomes and notes | Native Done, Not needed, reopen via Undo and occurrence-note isolation; SQLite and PostgreSQL assertions cover inherited outcomes, explicit Open, stale payloads and UUID/note retention. |
| Create/delete | Native blank-cell drag created a Task-linked Checklist visible in Today; Calendar editor deletion removed it. Permanent deletion intentionally clears Undo history. |
| Navigation and preferences | Native Day/Week/Month, next/previous date, date picker, Today reset, Calendar search, Week preference and resized height persisted across reload. |
| Recurrence rules | SQLite tests and isolated PostgreSQL cover daily, weekly, monthly, custom interval, selected dates and materialized schedules, including retained finite instances with no repeat-until date. |
| Failure and concurrency | Unit/adapter tests cover write/read failures, invalid ranges, atomic bulk rollback, failed inherited-outcome toggles, out-of-order reads, unmount/remount and reads returning after a mutation queue has drained. |
| Long histories/timezone | Regression tests cover more than 1,000 occurrences, long legacy durations, moved-in overdue instances, independent original identities, Vietnam midnight, leap dates and year rollover. |

## Reproducing checks

Run `node node_modules/vitest/vitest.mjs run --configLoader runner --cache=false --no-file-parallelism`
and `node node_modules/typescript/bin/tsc --noEmit --incremental false`.
The added suites are `calendar-today-regressions`, `calendar-items-regressions`
and `calendar-occurrence-validation`. Lint changed source/test files with oxlint.

Run `bash scripts/test-calendar-today.sh` from WSL with Docker. It creates a fresh
PostgreSQL 16 container with no network, ports or volumes, applies the schema
through 0034 and runs both Calendar move fixtures, then removes the container.
Additional repeat-edits and selected-dates PostgreSQL harnesses passed. The older
workspace-review fixture lacks permissive owner policies on two fake legacy
tables; its remaining assertions passed after adding those policies only inside
the disposable database. No production policy was changed for that fixture.

## Verification limits and release order

Browser QA uses a disposable Local database. Cloud adapter tests use mocked HTTP
transport backed by actual isolated SQLite state, plus actual PostgreSQL RPC
tests. These checks do not claim authenticated production mutation coverage or
real-device push delivery. Existing push scheduler/ownership assertions remain
part of the isolated database coverage.

Apply only migration 0034 to the existing production project, then deploy the
tested frontend. Test fixtures and QA records must never be sent to production.
