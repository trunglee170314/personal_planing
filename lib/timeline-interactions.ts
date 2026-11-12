import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from './data/repository';

export const TIMELINE_DAY_WIDTHS = { week: 46, month: 18, quarter: 8, year: 3 };
export type TimelineZoom = keyof typeof TIMELINE_DAY_WIDTHS;
export const TIMELINE_ZOOMS: TimelineZoom[] = [
  'week',
  'month',
  'quarter',
  'year',
];

/** Keep the date under the pointer fixed, accounting for the sticky outline. */
export function timelineZoomScroll(
  scrollLeft: number,
  pointerOffset: number,
  outlineWidth: number,
  oldDayWidth: number,
  newDayWidth: number,
) {
  const anchor = Math.max(outlineWidth, pointerOffset) - outlineWidth;
  const day = (scrollLeft + anchor) / oldDayWidth;
  return Math.max(0, day * newDayWidth - anchor);
}

/** Label/link occupancy stays inside the visible part of its own bar. */
export function visibleTimelineLabel(
  barLeft: number,
  barWidth: number,
  viewportLeft: number,
  viewportWidth: number,
) {
  const left = Math.max(barLeft + 8, viewportLeft + 8);
  const right = Math.min(
    barLeft + barWidth - 8,
    viewportLeft + viewportWidth - 8,
  );
  return right > left ? { left, width: right - left } : null;
}

export function timelineEdgeSpeed(pointer: number, start: number, end: number) {
  const margin = Math.min(48, (end - start) / 4);
  if (pointer < start + margin)
    return -Math.ceil(16 * Math.min(1, (start + margin - pointer) / margin));
  if (pointer > end - margin)
    return Math.ceil(16 * Math.min(1, (pointer - end + margin) / margin));
  return 0;
}

/** Accumulate small trackpad deltas; a single gesture cannot skip every scale. */
export function timelineWheelStep(
  previous: { delta: number; time: number; lastStep?: number },
  deltaY: number,
  deltaMode: number,
  now: number,
) {
  const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 480 : 1);
  const fresh =
    now - previous.time > 180 || Math.sign(delta) !== Math.sign(previous.delta);
  const total = (fresh ? 0 : previous.delta) + delta;
  const step =
    Math.abs(total) >= 60 &&
    (previous.lastStep === undefined || now - previous.lastStep >= 140)
      ? total > 0
        ? 1
        : -1
      : 0;
  return {
    step,
    state: {
      delta: Math.abs(total) >= 60 ? 0 : total,
      time: now,
      lastStep: step ? now : previous.lastStep,
    },
  };
}

/** Tokens protect all async state writes, including errors and follow-up requests. */
export function createTimelineLoadGuard() {
  let version = 0;
  let active = true;
  return {
    begin() {
      const token = ++version;
      return () => active && token === version;
    },
    invalidate() {
      version++;
    },
    dispose() {
      active = false;
      version++;
    },
  };
}

/** Restore the captured record, including exact timestamps and legacy nulls. */
export function restoreTimelineEntity(
  workspace: TimelineWorkspace,
  kind: 'goal' | 'task' | 'milestone',
  before: Goal | Task | TimelineMilestone,
): TimelineWorkspace {
  if (kind === 'goal')
    return {
      ...workspace,
      goals: workspace.goals.map((item) =>
        item.id === before.id ? (before as Goal) : item,
      ),
    };
  if (kind === 'task')
    return {
      ...workspace,
      tasks: workspace.tasks.map((item) =>
        item.id === before.id ? (before as Task) : item,
      ),
    };
  return {
    ...workspace,
    milestones: workspace.milestones.map((item) =>
      item.id === before.id ? (before as TimelineMilestone) : item,
    ),
  };
}
