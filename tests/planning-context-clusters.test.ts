import { describe, expect, it } from 'vitest';
import {
  matchesPlanningSearch,
  planningBreadcrumb,
  planningContext,
} from '../lib/planning-context';
import { clusterMilestones, milestoneMarkerWidth } from '../lib/workspace-view';

describe('inherited planning context', () => {
  const workspace = {
    goals: [
      { id: 'career', title: 'Career' },
      { id: 'health', title: 'Health' },
    ],
    tasks: [{ id: 'linux', title: 'Learn Linux' }],
    links: [{ task_id: 'linux', goal_id: 'career' }],
  };
  it('searches Checklist Goal and Task without copying or changing its title', () => {
    const context = planningContext(workspace, 'linux');
    expect(planningBreadcrumb(context)).toBe('Career › Learn Linux');
    for (const query of [
      'caree',
      'linux',
      'CAREER linux',
      'goal:caree chapter',
      'task:linux chapter',
      'goal:"Career" task:"Learn Linux"',
    ])
      expect(matchesPlanningSearch(query, context, 'Read chapter 1')).toBe(
        true,
      );
    expect(
      matchesPlanningSearch('goal:health', context, 'Health chapter'),
    ).toBe(false);
    expect(
      matchesPlanningSearch('task:windows', context, 'Windows chapter'),
    ).toBe(false);
    expect(workspace.tasks[0].title).toBe('Learn Linux');
  });
  it('derives rename/relink immediately and never invents an unavailable parent', () => {
    expect(
      planningBreadcrumb(
        planningContext(
          {
            ...workspace,
            goals: [{ id: 'career', title: 'Professional Growth' }],
          },
          'linux',
        ),
      ),
    ).toBe('Professional Growth › Learn Linux');
    expect(
      planningBreadcrumb(
        planningContext(
          { ...workspace, links: [{ task_id: 'linux', goal_id: 'health' }] },
          'linux',
        ),
      ),
    ).toBe('Health › Learn Linux');
    expect(planningBreadcrumb(planningContext(workspace, 'deleted-task'))).toBe(
      '',
    );
    expect(
      planningBreadcrumb(planningContext({ ...workspace, links: [] }, 'linux')),
    ).toBe('Learn Linux');
    expect(
      matchesPlanningSearch('goal:career', {}, 'Career in title only'),
    ).toBe(false);
  });
  it('handles quoted Goal names, multiple constraints, accents and empty scopes', () => {
    const context = { goal: 'Phát triển sự nghiệp', task: 'Học Linux' };
    expect(
      matchesPlanningSearch(
        'goal:"phat trien" task:linux commands',
        context,
        'Practice commands',
      ),
    ).toBe(true);
    expect(
      matchesPlanningSearch(
        'goal:"phat trien" goal:health',
        context,
        'Practice commands',
      ),
    ).toBe(false);
    expect(matchesPlanningSearch('goal:', context, 'Practice commands')).toBe(
      false,
    );
    expect(matchesPlanningSearch('', context, 'Practice commands')).toBe(true);
  });
});

describe('one-lane zoom-aware milestone clusters', () => {
  const marks = [
    { id: 'a', milestone_on: '2026-11-01' },
    { id: 'b', milestone_on: '2026-11-02' },
    { id: 'c', milestone_on: '2026-11-03' },
    { id: 'd', milestone_on: '2026-11-10' },
  ];
  it('keeps separate flags when Week zoom gives their actual footprints enough room', () => {
    expect(
      clusterMilestones(marks, 50).map((cluster) =>
        cluster.items.map((item) => item.id),
      ),
    ).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(clusterMilestones(marks, 28)).toHaveLength(4); // exact gap, not an arbitrary date bucket
  });
  it('clusters only pixel collisions in Month and separates again after zooming', () => {
    const month = clusterMilestones(marks, 18);
    expect(
      month.map((cluster) => cluster.items.map((item) => item.id)),
    ).toEqual([['a', 'b', 'c'], ['d']]);
    expect(month[0].width).toBe(48);
    expect(clusterMilestones(marks, 50)).toHaveLength(4);
    expect(marks.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('retains Important records and clusters same-day flags even at Week zoom', () => {
    const important = {
      id: 'important',
      title: 'Very important release',
      is_important: true,
      milestone_on: '2026-11-01',
    };
    const clustered = clusterMilestones([...marks, important], 50);
    expect(clustered[0].items.map((item) => item.id)).toEqual([
      'a',
      'important',
      'b',
    ]);
    expect(
      clustered[0].items.some(
        (item) => 'is_important' in item && item.is_important,
      ),
    ).toBe(true);
    expect(clusterMilestones([important], 50)[0].width).toBe(
      milestoneMarkerWidth(important),
    );
  });
  it('keeps a thousand same-day milestones in one bounded count, deterministic and lossless', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: `mark-${String(index).padStart(4, '0')}`,
      milestone_on: '2026-11-01',
    }));
    const clusters = clusterMilestones(items.toReversed(), 4);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].items).toEqual(items);
    expect(clusters[0].width).toBeLessThanOrEqual(80);
    for (const width of [0, -1, NaN, Infinity])
      expect(() => clusterMilestones(items, width)).toThrow();
  });
});
