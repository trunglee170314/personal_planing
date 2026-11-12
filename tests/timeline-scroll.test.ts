import { describe, expect, it } from 'vitest';
import {
  quantizeTimelineViewport,
  timelineDayWindow,
  TIMELINE_HORIZONTAL_BUCKET,
  TIMELINE_SCROLL_OVERSCAN,
  TIMELINE_VERTICAL_BUCKET,
} from '../lib/timeline-scroll';

const viewport = (left = 0, top = 0, width = 1000, height = 600) => ({
  left,
  top,
  width,
  height,
});

describe('Timeline coarse native-scroll snapshots', () => {
  it('keeps every horizontal pixel within a bucket on the same React snapshot', () => {
    const baseline = quantizeTimelineViewport(viewport(128));
    for (let left = 128; left < 256; ++left)
      expect(quantizeTimelineViewport(viewport(left))).toEqual(baseline);
  });
  it('changes the horizontal snapshot exactly at a 128px boundary', () => {
    expect(quantizeTimelineViewport(viewport(127.999)).left).toBe(0);
    expect(quantizeTimelineViewport(viewport(128)).left).toBe(128);
    expect(quantizeTimelineViewport(viewport(255.999)).left).toBe(128);
    expect(quantizeTimelineViewport(viewport(256)).left).toBe(256);
  });
  it('coarsens vertical positions independently at 80px boundaries', () => {
    expect(quantizeTimelineViewport(viewport(150, 79.99))).toMatchObject({
      left: 128,
      top: 0,
    });
    expect(quantizeTimelineViewport(viewport(150, 80))).toMatchObject({
      left: 128,
      top: 80,
    });
    expect(quantizeTimelineViewport(viewport(150, 159.99))).toMatchObject({
      left: 128,
      top: 80,
    });
  });
  it('refreshes dimensions exactly even without crossing a scroll bucket', () => {
    const first = quantizeTimelineViewport(viewport(130, 85, 1000.5, 600.25));
    const resized = quantizeTimelineViewport(viewport(140, 90, 1001.75, 601.5));
    expect(first).toEqual({
      left: 128,
      top: 80,
      width: 1000.5,
      height: 600.25,
    });
    expect(resized).toEqual({
      left: 128,
      top: 80,
      width: 1001.75,
      height: 601.5,
    });
  });
  it('lands directly on the correct bucket after a fast jump', () => {
    expect(quantizeTimelineViewport(viewport(12045.5, 2501))).toEqual({
      left: 12032,
      top: 2480,
      width: 1000,
      height: 600,
    });
  });
  it('returns immediately to previous buckets when the user reverses direction', () => {
    const positions = [130, 129, 128, 127, 1, 0].map(
      (left) => quantizeTimelineViewport(viewport(left)).left,
    );
    expect(positions).toEqual([128, 128, 128, 0, 0, 0]);
  });
  it('clamps browser overscroll and invalid dimensions to safe nonnegative values', () => {
    expect(quantizeTimelineViewport(viewport(-40, -20, -1, -2))).toEqual(
      viewport(0, 0, 0, 0),
    );
    expect(
      quantizeTimelineViewport(viewport(NaN, Infinity, -Infinity, NaN)),
    ).toEqual(viewport(0, 0, 0, 0));
  });
  it('preserves valid zero dimensions during hidden or initial measurement', () => {
    expect(quantizeTimelineViewport(viewport(240, 100, 0, 0))).toEqual(
      viewport(128, 80, 0, 0),
    );
  });
  it('does not mutate the native viewport values used by smooth labels', () => {
    const source = viewport(209.5, 123.5, 1000.5, 600.25);
    const before = { ...source };
    quantizeTimelineViewport(source);
    expect(source).toEqual(before);
  });
  it('reduces 2,401 pixel positions across a 2,400px scroll to only 19 distinct React windows', () => {
    const snapshots = new Set(
      Array.from({ length: 2401 }, (_, left) =>
        JSON.stringify(quantizeTimelineViewport(viewport(left))),
      ),
    );
    expect(snapshots.size).toBe(19);
    expect(snapshots.size).toBeLessThan(2401 / 100);
  });
  it('keeps scroll buckets smaller than their matching overscan windows', () => {
    expect(TIMELINE_SCROLL_OVERSCAN).toBeGreaterThan(
      TIMELINE_HORIZONTAL_BUCKET,
    );
    expect(TIMELINE_VERTICAL_BUCKET).toBeLessThan(160);
  });
});

describe('Timeline bucket-safe calendar columns', () => {
  it.each([46, 18, 8, 3])(
    'covers every actually visible day before the next horizontal bucket at %spx/day',
    (dayWidth) => {
      const rangeDays = 5000;
      for (const bucket of [0, 128, 1024, 5120]) {
        const window = timelineDayWindow(rangeDays, dayWidth, bucket, 1000);
        for (const movement of [0, 1, 63, 127.999]) {
          const actualLeft = bucket + movement;
          const firstVisible = Math.floor(actualLeft / dayWidth);
          const afterLastVisible = Math.ceil((actualLeft + 1000) / dayWidth);
          expect(window.first).toBeLessThanOrEqual(firstVisible);
          expect(window.end).toBeGreaterThanOrEqual(
            Math.min(rangeDays, afterLastVisible),
          );
        }
      }
    },
  );
  it('keeps Year-scale header coverage beyond the former 30-day/90px overscan', () => {
    const bucket = 1024,
      dayWidth = 3,
      width = 1000;
    const window = timelineDayWindow(5000, dayWidth, bucket, width);
    const rawRight = bucket + 127 + width;
    const formerEnd = Math.ceil((bucket + width) / dayWidth) + 30;
    expect(formerEnd * dayWidth).toBeLessThan(rawRight);
    expect(window.end * dayWidth).toBeGreaterThanOrEqual(rawRight);
  });
  it.each([46, 18, 8, 3])(
    'also covers reverse movement before the next committed frame at %spx/day',
    (dayWidth) => {
      const window = timelineDayWindow(5000, dayWidth, 1024, 1000);
      expect(window.first * dayWidth).toBeLessThanOrEqual(1024 - 128);
    },
  );
  it('uses at least 30 days of overscan when that exceeds the pixel minimum', () => {
    expect(timelineDayWindow(5000, 46, 4600, 920)).toEqual({
      first: 70,
      end: 150,
    });
    expect(timelineDayWindow(5000, 18, 1800, 900)).toEqual({
      first: 70,
      end: 180,
    });
  });
  it('clamps the beginning of the range instead of producing negative columns', () => {
    expect(timelineDayWindow(5000, 3, 0, 900)).toEqual({ first: 0, end: 380 });
    expect(timelineDayWindow(5000, 3, -100, 900)).toEqual({
      first: 0,
      end: 380,
    });
  });
  it('clamps the end and handles a viewport beyond the full range', () => {
    expect(timelineDayWindow(100, 18, 1700, 900)).toEqual({
      first: 64,
      end: 100,
    });
    expect(timelineDayWindow(100, 18, 10000, 900)).toEqual({
      first: 100,
      end: 100,
    });
  });
  it('returns an empty range when the calendar has zero days', () => {
    expect(timelineDayWindow(0, 18, 100, 900)).toEqual({ first: 0, end: 0 });
  });
  it('sanitizes invalid native viewport measurements without invalid columns', () => {
    expect(timelineDayWindow(5000, 3, NaN, Infinity)).toEqual({
      first: 0,
      end: 80,
    });
    expect(timelineDayWindow(5000, 3, -Infinity, -1)).toEqual({
      first: 0,
      end: 80,
    });
  });
  it.each([0, -1, NaN, Infinity])(
    'rejects invalid day scale %s',
    (dayWidth) => {
      expect(() => timelineDayWindow(100, dayWidth, 0, 900)).toThrow(
        RangeError,
      );
    },
  );
  it.each([-1, 1.5, NaN, Infinity])(
    'rejects invalid range length %s',
    (rangeDays) => {
      expect(() => timelineDayWindow(rangeDays, 18, 0, 900)).toThrow(
        RangeError,
      );
    },
  );
});
