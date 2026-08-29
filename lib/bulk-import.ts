import { vietnamInputToIso } from './calendar';
import type {
  CalendarWorkspace,
  CalendarItemType,
  GoalColor,
  Priority,
  TimelineWorkspace,
} from './data/repository';
import type { WorkbookSheet } from './xlsx-lite';

export type BulkConflictMode = 'skip' | 'update' | 'create';
export type BulkImportIssue = {
  sheet: string;
  row: number;
  message: string;
};
export type BulkGoalImport = {
  key: string;
  title: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  color_key: GoalColor;
};
export type BulkTaskImport = {
  key: string;
  goal_key: string | null;
  parent_task_key: string | null;
  dependency_task_key: string | null;
  title: string;
  priority: Priority;
  status: string;
  planned_start: string | null;
  planned_end: string | null;
  due_at: string | null;
  progress: number;
  is_milestone: boolean;
  link_url: string | null;
  link_label: string | null;
};
export type BulkCalendarImport = {
  key: string;
  item_type: CalendarItemType;
  goal_key: string | null;
  task_key: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string;
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrence_until: string | null;
  recurrence_interval: number;
  completed_at: string | null;
  not_needed_at: string | null;
  notification_offsets: number[];
  is_pinned: boolean;
};
export type BulkMilestoneImport = {
  key: string;
  goal_key: string | null;
  task_key: string | null;
  title: string;
  milestone_on: string;
  color_key: GoalColor | null;
};
export type BulkAnnotationImport = {
  target_type: 'task' | 'calendar' | 'milestone';
  target_key: string;
  goal_key: string | null;
  kind: 'comment' | 'link';
  body: string;
  url: string | null;
};
export type BulkImportPlan = {
  goals: BulkGoalImport[];
  tasks: BulkTaskImport[];
  calendar: BulkCalendarImport[];
  milestones: BulkMilestoneImport[];
  annotations: BulkAnnotationImport[];
};
export type BulkImportResult = {
  created: Record<'goals' | 'tasks' | 'checklists' | 'reminders' | 'milestones' | 'annotations', number>;
  updated: Record<'goals' | 'tasks' | 'checklists' | 'reminders' | 'milestones', number>;
  skipped: number;
};
export type ParsedBulkImport = {
  plan: BulkImportPlan;
  issues: BulkImportIssue[];
  sourceRows: number;
};

const colors = new Set<GoalColor>([
  'jade',
  'teal',
  'sky',
  'sapphire',
  'indigo',
  'plum',
  'amber',
  'terracotta',
  'rose',
  'coral',
  'lime',
  'slate',
]);
const priorities = new Set<Priority>(['low', 'medium', 'high', 'urgent']);
const statuses = new Set([
  'backlog',
  'planned',
  'in_progress',
  'blocked',
  'completed',
]);
const recurrences = new Set(['none', 'daily', 'weekly', 'monthly']);
const validOffsets = new Set([0, 5, 15, 60, 1440]);
const emptyPlan = (): BulkImportPlan => ({
  goals: [],
  tasks: [],
  calendar: [],
  milestones: [],
  annotations: [],
});
const headerKey = (value: string) =>
  value.trim().toLowerCase().replace(/[\s-]+/g, '_');
const clean = (value: unknown) =>
  value == null
    ? ''
    : typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ? String(value).trim()
      : '';
const optional = (value: unknown) => clean(value) || null;
const httpUrl = (value: unknown) => {
  const raw = optional(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Use a valid http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Use a valid http:// or https:// URL.');
  return raw;
};
const bool = (value: unknown) =>
  ['1', 'true', 'yes', 'y', 'x', 'done'].includes(clean(value).toLowerCase());

function dateValue(value: unknown) {
  const raw = clean(value);
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(raw) * 86_400_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const result = iso
    ? `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
    : local
      ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`
      : null;
  if (!result || Number.isNaN(new Date(`${result}T12:00:00Z`).getTime()))
    throw new Error('Use YYYY-MM-DD or DD/MM/YYYY.');
  return result;
}

function timeValue(value: unknown, fallback: string) {
  const raw = clean(value);
  if (!raw) return fallback;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const minutes = Math.round((Number(raw) % 1) * 1440);
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!match) throw new Error('Use 24-hour HH:mm time.');
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3]) {
    hour %= 12;
    if (match[3].toLowerCase() === 'pm') hour += 12;
  }
  if (hour > 23 || minute > 59) throw new Error('Use a valid time.');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function addDay(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function rowsFor(sheet: WorkbookSheet) {
  const [header = [], ...rows] = sheet.rows;
  const keys = header.map(headerKey);
  return rows
    .map((row, index) => ({
      row: index + 2,
      values: Object.fromEntries(keys.map((key, column) => [key, row[column] ?? ''])),
    }))
    .filter(({ values }) => Object.values(values).some((value) => clean(value)));
}

function sheetType(name: string) {
  const key = headerKey(name).replace(/s$/, '');
  if (key === 'goal') return 'goal';
  if (key === 'task') return 'task';
  if (key === 'checklist') return 'checklist';
  if (key === 'reminder') return 'reminder';
  if (key === 'milestone') return 'milestone';
  if (['annotation', 'links_&_comment', 'links_&_comments'].includes(key))
    return 'annotation';
  return null;
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const raw = clean(value);
  if (!raw) return fallback;
  const result = Number(raw);
  if (!Number.isFinite(result) || result < min || result > max)
    throw new Error(`Use a number from ${min} to ${max}.`);
  return result;
}

function limited(value: string, label: string, max: number) {
  if (value.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value;
}

export function parseWorkbook(sheets: WorkbookSheet[]): ParsedBulkImport {
  const plan = emptyPlan();
  const issues: BulkImportIssue[] = [];
  let sourceRows = 0;
  const seen = new Map<string, string>();
  const report = (sheet: string, row: number, message: string) =>
    issues.push({ sheet, row, message });
  for (const sheet of sheets) {
    if (headerKey(sheet.name) === 'instructions') continue;
    for (const entry of rowsFor(sheet)) {
      sourceRows++;
      const values = entry.values;
      const type = sheetType(sheet.name) ?? sheetType(clean(values.type));
      if (!type) {
        report(sheet.name, entry.row, 'Choose a supported sheet or add a Type column.');
        continue;
      }
      try {
        const title = clean(values.title);
        const key = clean(values.key) || `${type}:${title.toLowerCase()}`;
        if (type !== 'annotation' && !title) throw new Error('Title is required.');
        if (type !== 'annotation') limited(title, 'Title', type === 'task' ? 240 : 200);
        limited(key, 'Key', 200);
        if (type !== 'annotation') {
          const duplicate = seen.get(`${type}:${key.toLowerCase()}`);
          if (duplicate) throw new Error(`Key duplicates ${duplicate}.`);
          seen.set(`${type}:${key.toLowerCase()}`, `${sheet.name} row ${entry.row}`);
        }
        if (type === 'goal') {
          const color = (clean(values.color) || 'jade') as GoalColor;
          if (!colors.has(color)) throw new Error('Unknown Goal color.');
          const starts_on = dateValue(values.start_date);
          const ends_on = dateValue(values.end_date ?? values.deadline);
          if (starts_on && ends_on && ends_on < starts_on)
            throw new Error('End date cannot be before start date.');
          plan.goals.push({
            key,
            title,
            description: optional(values.description),
            starts_on,
            ends_on,
            color_key: color,
          });
        } else if (type === 'task') {
          const priority = (clean(values.priority) || 'medium') as Priority;
          const status = clean(values.status) || 'backlog';
          if (!priorities.has(priority)) throw new Error('Unknown priority.');
          if (!statuses.has(status)) throw new Error('Unknown Task status.');
          const planned_start = dateValue(values.start_date);
          const planned_end = dateValue(values.end_date);
          const due_at = dateValue(values.deadline);
          if (planned_start && planned_end && planned_end < planned_start)
            throw new Error('End date cannot be before start date.');
          if (planned_start && due_at && due_at < planned_start)
            throw new Error('Deadline cannot be before start date.');
          plan.tasks.push({
            key,
            goal_key: optional(values.goal_key ?? values.goal),
            parent_task_key: optional(values.parent_task_key),
            dependency_task_key: optional(values.dependency_task_key),
            title,
            priority,
            status,
            planned_start,
            planned_end,
            due_at,
            progress: Math.round(numberValue(values.progress, status === 'completed' ? 100 : 0, 0, 100)),
            is_milestone: bool(values.is_milestone),
            link_url: httpUrl(values.link_url),
            link_label: optional(values.link_label),
          });
        } else if (type === 'checklist' || type === 'reminder') {
          const date = dateValue(values.date ?? values.start_date);
          if (!date) throw new Error('Date is required.');
          const allDay = bool(values.all_day);
          const startTime = timeValue(values.start_time, allDay ? '00:00' : '09:00');
          const endTime = timeValue(values.end_time, allDay ? '00:00' : '09:30');
          const endDate = dateValue(values.end_date) ?? (allDay ? addDay(date) : date);
          const starts_at = vietnamInputToIso(`${date}T${startTime}`);
          const ends_at = vietnamInputToIso(`${endDate}T${endTime}`);
          if (ends_at <= starts_at) throw new Error('End must be after start.');
          const recurrence = clean(values.recurrence) || 'none';
          if (!recurrences.has(recurrence)) throw new Error('Unknown recurrence.');
          const recurrence_until = dateValue(values.repeat_until);
          if (type === 'checklist' && recurrence !== 'none' && !recurrence_until)
            throw new Error('Repeating checklists need Repeat until.');
          if (recurrence_until && recurrence_until < date)
            throw new Error('Repeat until cannot be before Date.');
          const taskKey = optional(values.task_key ?? values.task);
          if (type === 'checklist' && !taskKey)
            throw new Error('Checklist Task key is required.');
          const offsets = (clean(values.notify_minutes) || '15')
            .split(/[|;,]/)
            .filter(Boolean)
            .map(Number);
          if (offsets.some((offset) => !validOffsets.has(offset)))
            throw new Error('Notify minutes must use 0, 5, 15, 60, or 1440.');
          const state = clean(values.state).toLowerCase();
          if (state && !['open', 'done', 'not_needed'].includes(state))
            throw new Error('State must be open, done, or not_needed.');
          plan.calendar.push({
            key,
            item_type: type,
            goal_key: optional(values.goal_key ?? values.goal),
            task_key: type === 'checklist' ? taskKey : null,
            title,
            starts_at,
            ends_at,
            all_day: allDay,
            timezone: 'Asia/Ho_Chi_Minh',
            recurrence: recurrence as BulkCalendarImport['recurrence'],
            recurrence_until,
            recurrence_interval: Math.round(numberValue(values.repeat_every, 1, 1, 365)),
            completed_at: state === 'done' ? new Date().toISOString() : null,
            not_needed_at: state === 'not_needed' ? new Date().toISOString() : null,
            notification_offsets: offsets,
            is_pinned: bool(values.pinned),
          });
        } else if (type === 'milestone') {
          const milestone_on = dateValue(values.date);
          if (!milestone_on) throw new Error('Date is required.');
          const color = optional(values.color) as GoalColor | null;
          if (color && !colors.has(color)) throw new Error('Unknown milestone color.');
          const goal_key = optional(values.goal_key ?? values.goal);
          const task_key = optional(values.task_key ?? values.task);
          if (Boolean(goal_key) === Boolean(task_key))
            throw new Error('Choose exactly one Goal key or Task key.');
          plan.milestones.push({ key, goal_key, task_key, title, milestone_on, color_key: color });
        } else {
          const targetType = clean(values.target_type).toLowerCase();
          const kind = clean(values.kind).toLowerCase();
          const targetKey = clean(values.target_key);
          const url = httpUrl(values.url);
          const body = clean(values.body ?? values.label) || (kind === 'link' ? url : '');
          if (!['task', 'calendar', 'milestone'].includes(targetType))
            throw new Error('Target type must be task, calendar, or milestone.');
          if (!targetKey) throw new Error('Target key is required.');
          if (!['comment', 'link'].includes(kind))
            throw new Error('Kind must be comment or link.');
          if (!body) throw new Error('Body or label is required.');
          if (kind === 'link' && !url) throw new Error('Link URL is required.');
          limited(body, 'Body', 10_000);
          if (url) limited(url, 'URL', 2_048);
          plan.annotations.push({
            target_type: targetType as BulkAnnotationImport['target_type'],
            target_key: targetKey,
            goal_key: optional(values.goal_key ?? values.goal),
            kind: kind as BulkAnnotationImport['kind'],
            body,
            url: kind === 'link' ? url : null,
          });
        }
      } catch (error) {
        report(
          sheet.name,
          entry.row,
          error instanceof Error ? error.message : 'Invalid row.',
        );
      }
    }
  }
  if (!sourceRows) issues.push({ sheet: 'Workbook', row: 0, message: 'No data rows found.' });
  return { plan, issues, sourceRows };
}

const relationKey = (value: string | null | undefined) =>
  (value ?? '').trim().toLocaleLowerCase();

/** Adds relationship errors that require knowledge of the current workspace. */
export function validateBulkRelationships(
  parsed: ParsedBulkImport,
  timeline: Pick<TimelineWorkspace, 'goals' | 'tasks' | 'links' | 'milestones'>,
  calendar: Pick<CalendarWorkspace, 'sessions'>,
): BulkImportIssue[] {
  const issues: BulkImportIssue[] = [];
  const issue = (section: string, key: string, message: string) =>
    issues.push({ sheet: section, row: 0, message: `${key}: ${message}` });
  const goalAliases = new Map<string, string>();
  for (const goal of timeline.goals) {
    goalAliases.set(relationKey(goal.id), goal.id);
    goalAliases.set(relationKey(goal.title), goal.id);
  }
  for (const goal of parsed.plan.goals) {
    const canonical = `import-goal:${relationKey(goal.key)}`;
    goalAliases.set(relationKey(goal.key), canonical);
    goalAliases.set(relationKey(goal.title), canonical);
  }

  const taskGoal = new Map(timeline.links.map((link) => [link.task_id, link.goal_id]));
  const taskAliases = new Set<string>();
  const taskScopes = new Set<string>();
  for (const task of timeline.tasks) {
    for (const alias of [task.id, task.title]) {
      taskAliases.add(relationKey(alias));
      taskScopes.add(`${taskGoal.get(task.id) ?? ''}::${relationKey(alias)}`);
    }
  }
  for (const task of parsed.plan.tasks) {
    const goal = task.goal_key ? goalAliases.get(relationKey(task.goal_key)) : '';
    for (const alias of [task.key, task.title]) {
      taskAliases.add(relationKey(alias));
      taskScopes.add(`${goal ?? ''}::${relationKey(alias)}`);
    }
  }
  const hasTask = (key: string | null, goalKey?: string | null) => {
    if (!key) return false;
    if (goalKey) {
      const goal = goalAliases.get(relationKey(goalKey));
      if (goal && taskScopes.has(`${goal}::${relationKey(key)}`)) return true;
    }
    return taskAliases.has(relationKey(key));
  };

  for (const task of parsed.plan.tasks) {
    if (task.goal_key && !goalAliases.has(relationKey(task.goal_key)))
      issue('Tasks', task.key, `unknown Goal key “${task.goal_key}”.`);
    if (task.parent_task_key && !hasTask(task.parent_task_key, task.goal_key))
      issue('Tasks', task.key, `unknown Parent task key “${task.parent_task_key}”.`);
    if (task.dependency_task_key && !hasTask(task.dependency_task_key))
      issue('Tasks', task.key, `unknown Dependency task key “${task.dependency_task_key}”.`);
  }
  for (const item of parsed.plan.calendar) {
    if (item.goal_key && !goalAliases.has(relationKey(item.goal_key)))
      issue(item.item_type === 'checklist' ? 'Checklists' : 'Reminders', item.key, `unknown Goal key “${item.goal_key}”.`);
    if (item.task_key && !hasTask(item.task_key, item.goal_key))
      issue('Checklists', item.key, `unknown Task key “${item.task_key}”.`);
  }
  for (const milestone of parsed.plan.milestones) {
    if (milestone.goal_key && !goalAliases.has(relationKey(milestone.goal_key)))
      issue('Milestones', milestone.key, `unknown Goal key “${milestone.goal_key}”.`);
    if (milestone.task_key && !hasTask(milestone.task_key, milestone.goal_key))
      issue('Milestones', milestone.key, `unknown Task key “${milestone.task_key}”.`);
  }

  const targets = {
    task: new Set(taskAliases),
    calendar: new Set([
      ...calendar.sessions.flatMap((item) => [relationKey(item.id), relationKey(item.title)]),
      ...parsed.plan.calendar.flatMap((item) => [relationKey(item.key), relationKey(item.title)]),
    ]),
    milestone: new Set([
      ...timeline.milestones.flatMap((item) => [relationKey(item.id), relationKey(item.title)]),
      ...parsed.plan.milestones.flatMap((item) => [relationKey(item.key), relationKey(item.title)]),
    ]),
  };
  for (const annotation of parsed.plan.annotations)
    if (!targets[annotation.target_type].has(relationKey(annotation.target_key)))
      issue('Links & Comments', annotation.target_key, `unknown ${annotation.target_type} key.`);
  return issues;
}

export function parseDelimited(text: string, name = 'Import'): WorkbookSheet {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return { name, rows };
}

export const templateSheets: WorkbookSheet[] = [
  {
    name: 'Instructions',
    rows: [
      ['myplan bulk import template'],
      ['Keep Key values unique. Use the same keys in relation columns.'],
      ['Dates: YYYY-MM-DD or DD/MM/YYYY. Times: HH:mm Vietnam time.'],
      ['Checklist must reference a Task key. Reminder cannot reference a Task.'],
      ['Recurrence: none, daily, weekly, monthly. Notify: 0|5|15|60|1440.'],
      ['Delete this sheet only if you want; it is ignored during import.'],
    ],
  },
  { name: 'Goals', rows: [['Key', 'Title', 'Description', 'Start date', 'End date', 'Color']] },
  {
    name: 'Tasks',
    rows: [[
      'Key', 'Goal key', 'Parent task key', 'Dependency task key', 'Title', 'Priority',
      'Status', 'Start date', 'End date', 'Deadline', 'Progress', 'Is milestone',
      'Link URL', 'Link label',
    ]],
  },
  {
    name: 'Checklists',
    rows: [[
      'Key', 'Goal key', 'Task key', 'Title', 'Date', 'Start time', 'End date',
      'End time', 'All day', 'Recurrence', 'Repeat every', 'Repeat until',
      'Notify minutes', 'State', 'Pinned',
    ]],
  },
  {
    name: 'Reminders',
    rows: [[
      'Key', 'Title', 'Date', 'Start time', 'End date', 'End time', 'All day',
      'Recurrence', 'Repeat every', 'Repeat until', 'Notify minutes', 'State', 'Pinned',
    ]],
  },
  { name: 'Milestones', rows: [['Key', 'Goal key', 'Task key', 'Title', 'Date', 'Color']] },
  {
    name: 'Links & Comments',
    rows: [['Target type', 'Target key', 'Goal key', 'Kind', 'Body', 'URL']],
  },
];
