import { describe, expect, it } from 'vitest';
import type {
  Goal,
  Task,
  TimelineMilestone,
  TimelineWorkspace,
} from '../lib/data/repository';
import { milestoneAgenda, type AgendaPeriod } from '../lib/milestone-agenda';

function goal(id: string): Goal {
  return {
    id,
    title: id,
    description: null,
    progress: 0,
    status: 'active',
    starts_on: null,
    ends_on: null,
    archived_at: null,
    deleted_at: null,
    task_count: 0,
    completed_task_count: 0,
    color_key: 'jade',
  };
}
function task(id: string): Task {
  return {
    id,
    title: id,
    priority: 'medium',
    due_at: null,
    completed_at: null,
    workflow_status_id: 'planned',
    previous_status_id: null,
    planned_start: null,
    planned_end: null,
    progress: 0,
    parent_task_id: null,
    dependency_task_id: null,
    is_milestone: false,
    archived_at: null,
    deleted_at: null,
    link_url: null,
    link_label: null,
    active_checklist_count: 0,
    checklist_resolved_count: 0,
    checklist_done_count: 0,
  };
}
function mark(id: string, day: string): TimelineMilestone {
  return {
    id,
    title: id,
    milestone_on: day,
    goal_id: null,
    task_id: null,
    color_key: null,
    is_important: false,
  };
}
function fixture(): TimelineWorkspace {
  return {
    goals: [goal('Career')],
    tasks: [task('Learn Linux')],
    links: [{ task_id: 'Learn Linux', goal_id: 'Career' }],
    milestones: [],
    statuses: [],
  };
}
function project(
  workspace: TimelineWorkspace,
  period: AgendaPeriod = 'all',
  now = new Date('2026-11-19T00:00:00Z'),
  query = '',
  importantOnly = false,
) {
  return milestoneAgenda(workspace, { period, now, query, importantOnly });
}

describe('Milestone agenda date bounds', () => {
  it('uses Vietnam midnight instead of the host timezone', () => {
    const f = fixture();
    f.milestones = [
      mark('sun', '2026-11-22'),
      mark('mon', '2026-11-23'),
      mark('next-sun', '2026-11-29'),
      mark('after', '2026-11-30'),
    ];
    expect(
      project(f, 'this-week', new Date('2026-11-22T16:59:59Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['sun']);
    expect(
      project(f, 'this-week', new Date('2026-11-22T17:00:00Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['mon', 'next-sun']);
  });
  it('uses Monday through Sunday as a full week', () => {
    const f = fixture();
    f.milestones = [
      mark('before', '2026-11-15'),
      mark('mon', '2026-11-16'),
      mark('sun', '2026-11-22'),
      mark('after', '2026-11-23'),
    ];
    expect(project(f, 'this-week').map((item) => item.milestone.id)).toEqual([
      'mon',
      'sun',
    ]);
  });
  it('uses the next full week rather than the next seven days', () => {
    const f = fixture();
    f.milestones = [
      mark('today', '2026-11-19'),
      mark('mon', '2026-11-23'),
      mark('sun', '2026-11-29'),
      mark('after', '2026-11-30'),
    ];
    expect(project(f, 'next-week').map((item) => item.milestone.id)).toEqual([
      'mon',
      'sun',
    ]);
  });
  it('handles a week crossing the year boundary', () => {
    const f = fixture();
    f.milestones = [
      mark('dec', '2026-12-28'),
      mark('jan', '2027-01-03'),
      mark('after', '2027-01-04'),
    ];
    expect(
      project(f, 'this-week', new Date('2026-12-30T12:00Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['dec', 'jan']);
  });
  it('handles next week crossing the year boundary', () => {
    const f = fixture();
    f.milestones = [mark('next', '2026-12-28'), mark('sun', '2027-01-03')];
    expect(
      project(f, 'next-week', new Date('2026-12-23T12:00Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['next', 'sun']);
  });
  it('uses the whole month, including already passed dates', () => {
    const f = fixture();
    f.milestones = [
      mark('first', '2026-11-01'),
      mark('last', '2026-11-30'),
      mark('next', '2026-12-01'),
    ];
    expect(project(f, 'this-month').map((item) => item.milestone.id)).toEqual([
      'first',
      'last',
    ]);
  });
  it('handles leap February', () => {
    const f = fixture();
    f.milestones = [
      mark('first', '2028-02-01'),
      mark('leap', '2028-02-29'),
      mark('march', '2028-03-01'),
    ];
    expect(
      project(f, 'this-month', new Date('2028-02-15T00:00Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['first', 'leap']);
  });
  it('handles next month December to January', () => {
    const f = fixture();
    f.milestones = [
      mark('dec', '2026-12-31'),
      mark('jan', '2027-01-01'),
      mark('last', '2027-01-31'),
      mark('feb', '2027-02-01'),
    ];
    expect(
      project(f, 'next-month', new Date('2026-12-10T00:00Z')).map(
        (item) => item.milestone.id,
      ),
    ).toEqual(['jan', 'last']);
  });
  it('All includes past and future without truncation', () => {
    const f = fixture();
    f.milestones = [mark('past', '2000-01-01'), mark('future', '2200-12-31')];
    expect(project(f).map((item) => item.milestone.id)).toEqual([
      'past',
      'future',
    ]);
  });
  it('drops malformed dates and impossible February 30', () => {
    const f = fixture();
    f.milestones = [
      mark('bad', 'bad'),
      mark('impossible', '2026-02-30'),
      mark('valid', '2026-02-28'),
    ];
    expect(project(f).map((item) => item.milestone.id)).toEqual(['valid']);
  });
});

describe('Milestone agenda scope and relationships', () => {
  it('resolves active Task context through links', () => {
    const f = fixture();
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(project(f)[0]).toMatchObject({ task: f.tasks[0], goal: f.goals[0] });
  });
  it('keeps valid Inbox milestones', () => {
    const f = fixture();
    f.milestones = [mark('inbox', '2026-11-19')];
    expect(project(f)[0]).toMatchObject({ task: null, goal: null });
  });
  it('keeps active Tasks linked to unavailable Goals as Inbox', () => {
    const f = fixture();
    f.goals[0].status = 'archived';
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(project(f)[0]).toMatchObject({ task: f.tasks[0], goal: null });
  });
  it('drops orphaned direct Goal markers', () => {
    const f = fixture();
    f.milestones = [{ ...mark('m', '2026-11-19'), goal_id: 'missing' }];
    expect(project(f)).toEqual([]);
  });
  it('drops archived/deleted direct Goal markers', () => {
    const f = fixture();
    f.goals[0].archived_at = '2026-11-19T00:00Z';
    f.milestones = [{ ...mark('m', '2026-11-19'), goal_id: 'Career' }];
    expect(project(f)).toEqual([]);
  });
  it('drops unavailable Task markers', () => {
    const f = fixture();
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'missing' }];
    expect(project(f)).toEqual([]);
  });
  it('drops archived/deleted Task markers', () => {
    const f = fixture();
    f.tasks[0].archived_at = '2026-11-19T00:00Z';
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(project(f)).toEqual([]);
  });
  it('keeps completed Tasks and Goals as Timeline does', () => {
    const f = fixture();
    f.goals[0].status = 'completed';
    f.tasks[0].workflow_status_id = 'completed';
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(project(f)).toHaveLength(1);
  });
  it('keeps cancelled Tasks as Timeline does', () => {
    const f = fixture();
    f.tasks[0].workflow_status_id = 'cancelled';
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(project(f)).toHaveLength(1);
  });
  it('searches accent-insensitively by title or inherited Goal/Task', () => {
    const f = fixture();
    f.goals[0].title = 'Sự nghiệp';
    f.tasks[0].title = 'Học Linux';
    f.milestones = [
      { ...mark('m', '2026-11-19'), title: 'Ôn tập', task_id: 'Learn Linux' },
    ];
    expect(project(f, 'all', new Date(), 'on tap')).toHaveLength(1);
    expect(project(f, 'all', new Date(), 'su nghiep')).toHaveLength(1);
    expect(project(f, 'all', new Date(), 'linux')).toHaveLength(1);
  });
  it('honors Goal/Task scoped search', () => {
    const f = fixture();
    f.milestones = [{ ...mark('m', '2026-11-19'), task_id: 'Learn Linux' }];
    expect(
      project(f, 'all', new Date(), 'goal:Career task:"Learn Linux"'),
    ).toHaveLength(1);
    expect(project(f, 'all', new Date(), 'goal:Health')).toHaveLength(0);
  });
  it('Important only filters without changing the records', () => {
    const f = fixture();
    f.milestones = [
      mark('normal', '2026-11-19'),
      { ...mark('important', '2026-11-19'), is_important: true },
    ];
    expect(
      project(f, 'all', new Date(), '', true).map((item) => item.milestone.id),
    ).toEqual(['important']);
  });
  it('sorts by date then ID regardless of input order', () => {
    const f = fixture();
    f.milestones = [
      mark('b', '2026-11-20'),
      mark('a', '2026-11-20'),
      mark('c', '2026-11-19'),
    ];
    expect(project(f).map((item) => item.milestone.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
  it('does not mutate source while deriving context', () => {
    const f = fixture();
    f.milestones = [mark('m', '2026-11-19')];
    const before = structuredClone(f);
    project(f);
    expect(f).toEqual(before);
  });
});
