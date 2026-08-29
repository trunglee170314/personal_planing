import { describe, expect, it } from 'vitest';

import { layoutCalendarLanes } from '../lib/calendar-layout';

describe('calendar overlap layout', () => {
  it('restores full width after an overlapping group ends', () => {
    const layout = layoutCalendarLanes([
      { id: 'a', start: 13 * 60, end: 16 * 60 + 15 },
      { id: 'b', start: 13 * 60, end: 16 * 60 + 15 },
      { id: 'medicine', start: 16 * 60 + 30, end: 16 * 60 + 31 },
    ]);

    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 2 });
    expect(layout.get('b')).toEqual({ lane: 1, laneCount: 2 });
    expect(layout.get('medicine')).toEqual({ lane: 0, laneCount: 1 });
  });

  it('keeps transitively overlapping items in one group', () => {
    const layout = layoutCalendarLanes([
      { id: 'a', start: 60, end: 180 },
      { id: 'b', start: 120, end: 240 },
      { id: 'c', start: 210, end: 300 },
    ]);

    expect(layout.get('a')?.laneCount).toBe(2);
    expect(layout.get('b')?.laneCount).toBe(2);
    expect(layout.get('c')).toEqual({ lane: 0, laneCount: 2 });
  });

  it('starts a new full-width group when items only touch', () => {
    const layout = layoutCalendarLanes([
      { id: 'a', start: 60, end: 120 },
      { id: 'b', start: 120, end: 180 },
    ]);

    expect(layout.get('a')).toEqual({ lane: 0, laneCount: 1 });
    expect(layout.get('b')).toEqual({ lane: 0, laneCount: 1 });
  });
});
