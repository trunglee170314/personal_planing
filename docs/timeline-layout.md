# Timeline layout and interaction contracts

The Timeline has two presentation modes. Opening the outline shows one Task per
row, preserves the hierarchy and branch collapse state, and shows titles in the
outline rather than repeating them on Task bars. Tree guides connect visible
parents and children. Closing the outline packs scheduled Tasks within each Goal
and hides Tasks without a complete, drawable date range. Reopening it restores
the original outline order and hierarchy.

## Parent/Subtask gestures

With the outline open, every Task has a drag handle, including unscheduled Tasks.
A date bar can also be dragged into the outline. The destination's top quarter
means Before, middle half Inside, and bottom quarter After. Inside appends the
last child; Before/After use the destination Task's parent. After's insertion cue
is drawn after its complete visible branch. Dropping on the current Goal heading
appends a top-level Task. Inbox accepts only Tasks with no stored Goal link;
inactive-Goal links are not silently normalized into Inbox during a write.

The outline shows an Inside/Before/After cue, or a rejection reason. The pointer's
current surface and target are resolved again at release, including after edge
scrolling. Handle-origin drags stay structural; a date bar entering the outline
clears its date preview. An invalid outline drop cannot fall back to a date
write. Calendar vertical reordering is restricted to the same parent and Goal;
resize handles and milestones retain date-only behavior. Escape, blur and lost
capture cancel unfinished gestures. Old preview promises cannot affect a newer
or canceled gesture. Existing messages retain their layout height while dragging
so feedback cannot shift a target beneath the pointer.

Preview returns an opaque version plus the complete active Task tree. The client
compares that tree with its frozen view, so an already stale outline cannot use a
fresh version to overwrite another session's parent change. The atomic server
command checks the full active Task snapshot under the existing account mutation
lock, then validates same raw Goal, self/descendant cycles, active ancestors and
targets. Only the moved root's parent and destination sibling order are written;
all descendant links, Task dates/status/other metadata, Calendar entries and
milestone ownership remain. Existing derived Goal-progress rules still apply.

Parent and order produce one normal History/Undo receipt. Known view-level no-ops
are skipped; backend no-ops reject before writing so older Undo history remains
available. On success the destination parent/Goal opens, canonical data reloads,
and the moved row is revealed and focused. Version rejection reloads the tree and
keeps its explanation visible. Errors never apply a partial parent/order update.

Online requires migration 0035 and schema reload before the frontend. Local uses
`timeline-hierarchy.mjs` through dedicated preview/restructure endpoints. Both
adapters expose `previewTimelineHierarchy` and `restructureTimeline`; legacy Goal
reordering remains separate.

Verification on 2026-11-19: 95 added hierarchy tests cover Local storage/HTTP,
Cloud/Local repository and Undo contracts, drop geometry, full-tree comparisons,
no-ops and malformed ancestry. The full suite passed 683 tests with one opt-in
System Map benchmark skipped. An unchanged Today stress test timed out once
under concurrent browser compilation; it passed alone and the full suite passed
again without changing code or timeout settings. Typecheck and changed-file lint
passed. The network-isolated PostgreSQL 16 harness verifies all placements,
subtree/metadata/attachment preservation, version conflicts, exact Undo,
atomicity, approval and ownership.

Disposable browser QA exercised handle/bar Inside, a closed destination opening,
Before/After an expanded branch, Goal-root placement with a grandchild, an
unscheduled Task, Ctrl+Z, cycle/cross-Goal rejection and persistence after reload.
A simulated second session's parent edit was preserved and the stale view was
rejected. Direct disposable database comparisons confirmed unchanged Task
metadata and attachments. A calendar date-only drag plus Undo retained the
parent and restored exact dates. These checks do not imply authenticated
production planning-record mutations; no QA fixtures belong in the live project.

## Compact rows

`lib/timeline-layout.ts` indexes relationships and milestones once per data/filter
revision. It calculates layout when the data, zoom, search or collapse state
changes, independently of the horizontal viewport. Scrolling does not repack
Tasks. Lane membership stays frozen during a pointer gesture and its save.

Each Task owns a union of horizontal occupied intervals: its inclusive date bar
and every rendered milestone marker or cluster, including Important labels and
milestones outside the Task date range. Two Tasks share a lane only if none of
their intervals collide, with a four-pixel visual gap. Empty space between a bar
and a distant milestone remains available. Markers from different Tasks are
never clustered together to bypass collision checks. Goal boundaries remain
separate, and packing never edits dates, order or relationships.

Normal flags use a zoom-aware width: 24 px in Week, 14 px in Month, and a readable
10 px minimum in Quarter/Year. They are centered within their day when space
allows. Month flags therefore fit both the first and last day of a Task without
blocking an adjacent phase through an oversized invisible footprint. Important
labels and count clusters retain their full widths. Rendering, culling and
packing consume the same cluster width and day offset. If forming a wider count
creates a new collision to its left, clustering merges backward until the lane
is clear. Overview scales can still require separate lanes for real collisions.

Compact bars have a two-pixel inset on each end so adjacent date spans can share
a lane. The ten-pixel minimum bar width still prevents tiny Tasks from visually
overlapping at overview scales. The renderer uses the same dimensions as layout.
Titles and inline links remain inside the visible portion of their own bars;
very narrow linked bars expose their link on hover or keyboard focus. Full titles
remain available through tooltips and accessible names.

Title X positions use a zero-width native CSS sticky carrier, clipped to the bar
with `overflow: clip`. This avoids waiting for React while the browser scrolls,
and avoids pushing the title prefix left near the end of a bar. A cached DOM
registry updates only available text width, link fit and popup alignment using
the exact scroll offset. It does not read per-bar DOM geometry. Twenty-four
pixels are required for the inline link plus its gap; narrower visible fragments
retain the hover/focus popup.

## Viewport and input

Row offsets exclude the 48-pixel sticky header. Binary search selects the visible
vertical window with overscan. Compact rows also omit horizontally offscreen
Task groups while retaining any group with a visible bar or milestone. Selected
and pointer-captured items stay mounted. Keyboard navigation operates on the
layout model, scrolls to the next item, then focuses its rendered control.
React viewport snapshots use 128-pixel horizontal and 80-pixel vertical buckets;
native label movement and pointer calculations still use exact scroll positions.
Horizontal overscan is at least 240 pixels at every zoom, including Year, where
30 days alone would leave gaps before the next viewport bucket updates. Exact
previous scroll offsets distinguish horizontal movement from vertical scrolling
when automatically extending the date range.

The toolbar lives below the heading and contains Today, Milestones, Important only, search,
outline visibility and Week/Month/Quarter/Year. Ctrl+wheel over the board uses a
nonpassive listener, prevents browser zoom and keeps the date under the pointer
anchored. Small wheel deltas accumulate and a 140 ms cooldown limits burst
changes. Header weekdays, months and date tooltips use English.

The Milestones dialog reads the full active workspace independently of the chart
viewport, search, outline and Important filter. It provides This week, Next week,
This month, Next month and All, plus its own search and Important filter. Weeks
run Monday–Sunday and full calendar months use Vietnam time; All includes past
dates. Archived/deleted owners are excluded, and an active Task whose Goal is
unavailable follows the outline's Inbox fallback. Current Task–Goal links supply
context rather than potentially stale milestone Goal fields.

Go to date closes the dialog before revealing the owner's Goal and Task ancestor
chain, clearing conflicting chart filters and scrolling to the marker. Unscheduled
Tasks open the outline so their milestones remain reachable. Focus targets the
rendered marker or its containing cluster after virtualization updates; dialog
focus restoration is suppressed for navigation and shared-editor actions. Escape
and Close retain normal focus restoration. These actions never change dates.

Dragging supports edge scrolling with the scroll delta included in date
calculation. Outline mode provides a drop cue for vertical reorder; compact mode
uses horizontal date movement. Blank compact lanes create within the Goal rather
than selecting an arbitrary Task as a parent. Escape, blur and lost capture
cancel an unfinished gesture. External data changes cancel an active unsaved
gesture before refreshing.

## Loading and recovery

Request tokens reject out-of-order responses and post-unmount state writes.
Reads settle against the shared mutation lane. Ending a gesture drains any
deferred refresh. Failed optimistic saves restore the captured record, including
the exact deadline timestamp and legacy/null fields. Holiday reads are cached,
invalidated by holiday changes and nonblocking for the main planning data. Note
requests are generation-scoped so older hover results cannot refill an
invalidated cache.

The chart opts into `getTimelineWorkspace({ includeChecklistCounts: false })`.
This omits expensive Calendar history reads/expansion because the chart does not
display those counters. The default read remains complete for shared editors,
completion confirmation and other consumers. The option does not change writes,
ownership or approval rules and requires no database migration.

## Regression checks

`timeline-layout`, `timeline-tree`, `timeline-interactions`, `timeline-read`,
`timeline-cloud-read` and `timeline-api-read` tests cover packing at every scale,
sparse milestone intervals, partial schedules, hierarchy, deep trees, viewport
boundaries, pointer anchoring, burst wheel input, request ownership, exact
rollback, pagination and both data adapters. `milestone-agenda` covers Vietnam
date boundaries, calendar weeks/months, scope, context and independent filters.
`timeline-milestone-boundary` verifies adjacent phases and actual marker footprints
at each zoom, including deterministic randomized clustering cases. Existing Timeline command, Undo,
Calendar and selected-date suites remain relevant.

Browser QA must use an isolated Local database. Check outline toggling, short-bar
links, sticky titles, cluster lists, keyboard traversal past the viewport,
drag/resize saves, Undo, edge scrolling and native Ctrl+wheel behavior. Unit
geometry benchmarks are not browser FPS measurements. Cloud smoke checks at the
sign-in page do not establish authenticated production mutation coverage.
