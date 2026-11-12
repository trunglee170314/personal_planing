import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from './data/repository';
import type { TimelineOutlineRow } from './timeline-outline';
import {
  clusterMilestones,
  MILESTONE_LANE_HEIGHT,
  type MilestoneCluster,
} from './workspace-view';

export type TimelineTaskRow = Extract<TimelineOutlineRow, { kind: 'task' }>;
export type TimelineInterval = { left: number; right: number };
export type TaskLayout = {
  row: TimelineTaskRow;
  start: string | null;
  end: string | null;
  left: number;
  width: number;
  milestones: TimelineMilestone[];
  clusters: MilestoneCluster<TimelineMilestone>[];
  footprints: TimelineInterval[];
};
export type TimelineIndex = {
  goalsById: Map<string, Goal>;
  tasksById: Map<string, Task>;
  taskMilestones: Map<string, TimelineMilestone[]>;
  goalMilestones: Map<string | null, TimelineMilestone[]>;
};
export type TimelineLayoutRow = {
  key: string;
  kind: 'goal' | 'tasks';
  goal?: Goal;
  tasks: TaskLayout[];
  milestones: TimelineMilestone[];
  clusters: MilestoneCluster<TimelineMilestone>[];
  top: number;
  height: number;
};
export type TimelineLayout = {
  rows: TimelineLayoutRow[];
  totalHeight: number;
  plansByTaskId: Map<string, TaskLayout>;
};

const DAY_MS = 86_400_000;
export const TIMELINE_ITEM_GAP = 4;

/**
 * Each result contains last-sibling flags for the ancestors and the row itself.
 * Skip a parent's complete subtree when deciding whether it has a later sibling.
 * Call this on the filtered outline before virtualization, so offscreen siblings
 * still continue their ancestor guides.
 */
export function timelineTreeGuides(rows: TimelineOutlineRow[]) {
  const lastSibling = new Map<string, boolean>();
  const followingDepths: number[] = [];
  for (let i = rows.length - 1; i >= 0; --i) {
    const row = rows[i];
    if (row.kind === 'goal') {
      followingDepths.length = 0;
      continue;
    }
    while (
      followingDepths.length &&
      followingDepths[followingDepths.length - 1] > row.depth
    )
      followingDepths.pop();
    const last = followingDepths[followingDepths.length - 1] !== row.depth;
    lastSibling.set(row.task.id, last);
    if (!last) followingDepths.pop();
    followingDepths.push(row.depth);
  }
  const result = new Map<string, boolean[]>();
  const ancestors: boolean[] = [];
  for (const row of rows) {
    if (row.kind === 'goal') {
      ancestors.length = 0;
      continue;
    }
    ancestors.length = Math.min(ancestors.length, row.depth);
    // Missing ancestors in a legacy/filtered outline cannot have a visible line.
    while (ancestors.length < row.depth) ancestors.push(true);
    const last = lastSibling.get(row.task.id)!;
    result.set(row.task.id, [...ancestors, last]);
    ancestors.push(last);
  }
  return result;
}

function dayNumber(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse normalizes invalid dates such as February 30.
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    return null;
  return time / DAY_MS;
}

/** Build once per data/filter revision, rather than scanning milestones per row. */
export function indexTimeline(
  workspace: Pick<TimelineWorkspace, 'goals' | 'tasks' | 'milestones'>,
  importantOnly = false,
): TimelineIndex {
  const taskMilestones = new Map<string, TimelineMilestone[]>();
  const goalMilestones = new Map<string | null, TimelineMilestone[]>();
  for (const milestone of workspace.milestones) {
    if (importantOnly && !milestone.is_important) continue;
    if (dayNumber(milestone.milestone_on) === null) continue;
    if (milestone.task_id) {
      const items = taskMilestones.get(milestone.task_id) ?? [];
      items.push(milestone);
      taskMilestones.set(milestone.task_id, items);
    } else {
      const items = goalMilestones.get(milestone.goal_id) ?? [];
      items.push(milestone);
      goalMilestones.set(milestone.goal_id, items);
    }
  }
  return {
    goalsById: new Map(workspace.goals.map((goal) => [goal.id, goal])),
    tasksById: new Map(workspace.tasks.map((task) => [task.id, task])),
    taskMilestones,
    goalMilestones,
  };
}

/** Merge only touching/overlapping pieces, retaining genuine sparse gaps. */
function mergeIntervals(items: TimelineInterval[]): TimelineInterval[] {
  const merged: TimelineInterval[] = [];
  for (const item of [...items].sort(
    (a, b) => a.left - b.left || a.right - b.right,
  )) {
    const previous = merged.at(-1);
    if (previous && item.left <= previous.right)
      previous.right = Math.max(previous.right, item.right);
    else merged.push({ ...item });
  }
  return merged;
}

/** All pieces belong to one Task, including markers outside its scheduled dates. */
function taskLayout(
  row: TimelineTaskRow,
  index: TimelineIndex,
  origin: number,
  dayWidth: number,
  compact: boolean,
): TaskLayout {
  const start = row.task.planned_start;
  const end = row.task.due_at?.slice(0, 10) ?? row.task.planned_end;
  const startDay = dayNumber(start),
    endDay = dayNumber(end);
  const scheduled = startDay !== null && endDay !== null && endDay >= startDay;
  const left = scheduled
    ? (startDay - origin) * dayWidth + (compact ? 2 : 0)
    : 0;
  const width = scheduled
    ? Math.max(10, (endDay - startDay + 1) * dayWidth - (compact ? 4 : 0))
    : 0;
  const milestones = index.taskMilestones.get(row.task.id) ?? [];
  const clusters = clusterMilestones(milestones, dayWidth);
  const intervals: TimelineInterval[] = width
    ? [{ left, right: left + width }]
    : [];
  for (const cluster of clusters) {
    const markerLeft = (dayNumber(cluster.day)! - origin) * dayWidth;
    intervals.push({ left: markerLeft, right: markerLeft + cluster.width });
  }
  return {
    row,
    start: scheduled ? start : null,
    end: scheduled ? end : null,
    left,
    width,
    milestones,
    clusters,
    footprints: mergeIntervals(intervals),
  };
}

/** Each lane holds sorted non-overlapping occupied pieces. */
function fits(occupied: TimelineInterval[], candidate: TimelineInterval[]) {
  for (const piece of candidate) {
    let low = 0,
      high = occupied.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (occupied[middle].right + TIMELINE_ITEM_GAP <= piece.left)
        low = middle + 1;
      else high = middle;
    }
    if (
      low < occupied.length &&
      occupied[low].left < piece.right + TIMELINE_ITEM_GAP
    )
      return false;
  }
  return true;
}

/** Pure render layout: never rewrites task dates, hierarchy, order, or markers. */
export function buildTimelineLayout(
  sourceRows: TimelineOutlineRow[],
  index: TimelineIndex,
  rangeStartKey: string,
  dayWidth: number,
  compact: boolean,
): TimelineLayout {
  const origin = dayNumber(rangeStartKey);
  if (origin === null || !Number.isFinite(dayWidth) || dayWidth <= 0)
    throw new Error('Invalid timeline geometry.');
  const rows: TimelineLayoutRow[] = [];
  const plansByTaskId = new Map<string, TaskLayout>();
  let tasks: TaskLayout[] = [];
  let groupKey = 'inbox';
  function appendTasks() {
    if (!compact) {
      for (const task of tasks)
        rows.push({
          key: `task:${task.row.task.id}`,
          kind: 'tasks',
          tasks: [task],
          milestones: task.milestones,
          clusters: task.clusters,
          top: 0,
          height: 42 + (task.milestones.length ? MILESTONE_LANE_HEIGHT : 0),
        });
    } else {
      const lanes: { tasks: TaskLayout[]; occupied: TimelineInterval[] }[] = [];
      // A stable date ordering produces predictable lanes independent of scroll.
      const sorted = tasks
        .filter((task) => task.width > 0)
        .map((task, order) => ({ task, order }))
        .sort((a, b) => a.task.left - b.task.left || a.order - b.order);
      for (const { task } of sorted) {
        let lane = lanes.find((item) => fits(item.occupied, task.footprints));
        if (!lane) {
          lane = { tasks: [], occupied: [] };
          lanes.push(lane);
        }
        lane.tasks.push(task);
        lane.occupied = mergeIntervals([...lane.occupied, ...task.footprints]);
      }
      for (const lane of lanes) {
        const milestones = lane.tasks.flatMap((task) => task.milestones);
        rows.push({
          key: `compact:${groupKey}:${lane.tasks[0].row.task.id}`,
          kind: 'tasks',
          tasks: lane.tasks,
          milestones,
          // Keep cluster ownership per Task; distinct Tasks are never clustered.
          clusters: lane.tasks.flatMap((task) => task.clusters),
          top: 0,
          height: 42 + (milestones.length ? MILESTONE_LANE_HEIGHT : 0),
        });
      }
    }
    tasks = [];
  }
  for (const row of sourceRows) {
    if (row.kind === 'goal') {
      appendTasks();
      groupKey = row.goal.id;
      const milestones =
        index.goalMilestones.get(groupKey === 'inbox' ? null : groupKey) ?? [];
      rows.push({
        key: `goal:${groupKey}`,
        kind: 'goal',
        goal: row.goal,
        tasks: [],
        milestones,
        clusters: clusterMilestones(milestones, dayWidth),
        top: 0,
        height: 56 + (milestones.length ? MILESTONE_LANE_HEIGHT : 0),
      });
    } else {
      const task = taskLayout(row, index, origin, dayWidth, compact);
      plansByTaskId.set(row.task.id, task);
      tasks.push(task);
    }
  }
  appendTasks();
  let totalHeight = 0;
  for (const row of rows) {
    row.top = totalHeight;
    totalHeight += row.height;
  }
  return { rows, totalHeight, plansByTaskId };
}

/** scrollTop is relative to the first data row (excluding the 48px header). */
export function visibleTimelineRows(
  rows: TimelineLayoutRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 160,
) {
  const totalHeight = rows.length
    ? rows[rows.length - 1].top + rows[rows.length - 1].height
    : 0;
  const top = Math.max(0, scrollTop);
  const lower = Math.max(0, top - Math.max(0, overscan));
  const upper = Math.max(
    lower,
    top + Math.max(0, viewportHeight) + Math.max(0, overscan),
  );
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top + rows[middle].height <= lower) low = middle + 1;
    else high = middle;
  }
  const start = low;
  if (upper === lower) {
    const paddingTop = rows[start]?.top ?? totalHeight;
    return {
      start,
      end: start,
      paddingTop,
      paddingBottom: totalHeight - paddingTop,
    };
  }
  high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top < upper) low = middle + 1;
    else high = middle;
  }
  const end = low;
  return {
    start,
    end,
    paddingTop: rows[start]?.top ?? totalHeight,
    paddingBottom: Math.max(
      0,
      totalHeight - (end ? rows[end - 1].top + rows[end - 1].height : 0),
    ),
  };
}
