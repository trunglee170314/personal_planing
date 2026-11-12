import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../lib/data/repository';
import { timelineTreeGuides } from '../lib/timeline-layout';
import {
  buildTimelineRows,
  type TimelineOutlineRow,
} from '../lib/timeline-outline';

// These fixtures deliberately expose only the fields consumed by tree layout.
const goal = (id: string): Goal => ({ id, title: id }) as Goal;
const task = (id: string, parent: string | null = null): Task =>
  ({ id, title: id, parent_task_id: parent }) as Task;
const group = (id: string): TimelineOutlineRow => ({
  kind: 'goal',
  goal: goal(id),
});
const row = (id: string, depth: number): TimelineOutlineRow => ({
  kind: 'task',
  task: task(id),
  goalId: 'goal',
  depth,
  hasChildren: false,
});

describe('Timeline tree guides', () => {
  it('marks a last root with descendants as last rather than treating its child as a sibling', () => {
    const guides = timelineTreeGuides([
      group('g'),
      row('parent', 0),
      row('child', 1),
      row('leaf', 2),
    ]);
    expect([...guides]).toEqual([
      ['parent', [true]],
      ['child', [true, true]],
      ['leaf', [true, true, true]],
    ]);
  });
  it('continues a root ancestor line past its whole subtree when a later root exists', () => {
    const guides = timelineTreeGuides([
      group('g'),
      row('a', 0),
      row('a1', 1),
      row('a1leaf', 2),
      row('b', 0),
    ]);
    expect([...guides]).toEqual([
      ['a', [false]],
      ['a1', [false, true]],
      ['a1leaf', [false, true, true]],
      ['b', [true]],
    ]);
  });
  it('keeps the correct continuing lines for siblings with nested subtrees', () => {
    const guides = timelineTreeGuides([
      group('g'),
      row('root', 0),
      row('a', 1),
      row('a1', 2),
      row('b', 1),
      row('b1', 2),
      row('b2', 2),
    ]);
    expect(guides.get('root')).toEqual([true]);
    expect(guides.get('a')).toEqual([true, false]);
    expect(guides.get('a1')).toEqual([true, false, true]);
    expect(guides.get('b')).toEqual([true, true]);
    expect(guides.get('b1')).toEqual([true, true, false]);
    expect(guides.get('b2')).toEqual([true, true, true]);
  });
  it('resets all ancestry at Goal boundaries', () => {
    const guides = timelineTreeGuides([
      group('g1'),
      row('a', 0),
      row('a1', 1),
      group('g2'),
      row('b', 0),
      row('b1', 1),
    ]);
    expect(guides.get('a')).toEqual([true]);
    expect(guides.get('a1')).toEqual([true, true]);
    expect(guides.get('b')).toEqual([true]);
    expect(guides.get('b1')).toEqual([true, true]);
  });
  it('uses only the currently search-visible siblings', () => {
    const full = [
      group('g'),
      row('a', 0),
      row('a1', 1),
      row('a2', 1),
      row('b', 0),
    ];
    expect(timelineTreeGuides(full).get('a1')).toEqual([false, false]);
    const filtered = full.filter(
      (item) => item.kind === 'goal' || ['a', 'a1'].includes(item.task.id),
    );
    expect(timelineTreeGuides(filtered).get('a1')).toEqual([true, true]);
  });
  it('does not change the source outline or accidentally show missing ancestor lines', () => {
    const rows = [group('g'), row('orphan', 2), row('root', 0)];
    const before = structuredClone(rows);
    expect(timelineTreeGuides(rows).get('orphan')).toEqual([true, true, true]);
    expect(rows).toEqual(before);
    expect(timelineTreeGuides([]).size).toBe(0);
  });
  it('handles deep visible trees without recursive traversal', () => {
    const rows = [
      group('g'),
      ...Array.from({ length: 1500 }, (_, depth) => row(`t${depth}`, depth)),
    ];
    const guides = timelineTreeGuides(rows);
    expect(guides.size).toBe(1500);
    expect(guides.get('t1499')).toEqual(Array(1500).fill(true));
  });
});

describe('Timeline grouped outline work', () => {
  it('resolves Goal membership once per Task even with many Goals', () => {
    class CountedLinks extends Map<string, string> {
      reads = 0;
      get(key: string) {
        this.reads++;
        return super.get(key);
      }
    }
    const goals = Array.from({ length: 100 }, (_, i) => goal(`g${i}`));
    const tasks = Array.from({ length: 2000 }, (_, i) => task(`t${i}`));
    const links = new CountedLinks(
      tasks.map((item, i) => [item.id, goals[i % goals.length].id]),
    );
    const rows = buildTimelineRows({ goals, tasks }, links, new Set());
    expect(rows.filter((item) => item.kind === 'task')).toHaveLength(2000);
    expect(links.reads).toBeLessThanOrEqual(tasks.length * 2);
  });
  it('preserves within-Goal input order, Inbox fallback and cross-Goal parent detachment', () => {
    const goals = [goal('g1'), goal('g2')];
    const tasks = [
      task('a'),
      task('cross-child', 'a'),
      task('b'),
      task('inbox'),
    ];
    const rows = buildTimelineRows(
      { goals, tasks },
      new Map([
        ['a', 'g1'],
        ['cross-child', 'g2'],
        ['b', 'g1'],
        ['inbox', 'retired-goal'],
      ]),
      new Set(),
    );
    expect(
      rows.map((item) =>
        item.kind === 'goal'
          ? item.goal.id
          : [item.task.id, item.depth, item.goalId],
      ),
    ).toEqual([
      'g1',
      ['a', 0, 'g1'],
      ['b', 0, 'g1'],
      'g2',
      ['cross-child', 0, 'g2'],
      'inbox',
      ['inbox', 0, null],
    ]);
  });
  it('does not reintroduce consumed cycle descendants after collapse', () => {
    const tasks = [task('a', 'b'), task('b', 'a'), task('leaf', 'b')];
    const rows = buildTimelineRows(
      { goals: [goal('g')], tasks },
      new Map(tasks.map((item) => [item.id, 'g'])),
      new Set(),
      new Set(['a']),
    );
    expect(
      rows.filter((item) => item.kind === 'task').map((item) => item.task.id),
    ).toEqual(['a']);
  });
});
