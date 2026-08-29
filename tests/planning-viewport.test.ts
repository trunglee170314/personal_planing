import { describe, expect, it } from 'vitest';
import {
  mapEdgeEmphasis,
  timelineTodayScrollLeft,
} from '../lib/planning-viewport';

describe('Timeline Today position', () => {
  it('positions Today within the usable chart beside the sticky outline', () => {
    const offset = 2000;
    const scroll = timelineTodayScrollLeft(offset, 1200, 240);
    expect(240 + offset - scroll).toBe(240 + (1200 - 240) / 3);
  });
  it('handles a hidden outline, early dates and narrow viewports', () => {
    expect(timelineTodayScrollLeft(2000, 1200, 0)).toBe(1600);
    expect(timelineTodayScrollLeft(10, 1200, 240)).toBe(0);
    expect(timelineTodayScrollLeft(2000, 200, 240)).toBe(2000);
  });
});

describe('System Map connection emphasis', () => {
  it('highlights both incoming and outgoing directly connected edges', () => {
    expect(mapEdgeEmphasis('active', 'other', 'active', false)).toBe('hover');
    expect(mapEdgeEmphasis('other', 'active', 'active', false)).toBe('hover');
    expect(mapEdgeEmphasis('other', 'third', 'active', false)).toBe('dim');
  });
  it('preserves selected edges and restores their state after hover', () => {
    expect(mapEdgeEmphasis('active', 'other', 'active', true)).toBe('hover');
    expect(mapEdgeEmphasis('other', 'third', 'active', true)).toBe('selected');
    expect(mapEdgeEmphasis('active', 'other', null, true)).toBe('selected');
    expect(mapEdgeEmphasis('active', 'other', null, false)).toBe('normal');
  });
});
