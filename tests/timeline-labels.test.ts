import { describe, expect, it, vi } from 'vitest';
import {
  collectTimelineLabels,
  syncTimelineLabels,
  type TimelineLabel,
} from '../lib/timeline-labels';

function fixture(left: number, width: number) {
  const properties = new Map<string, string>();
  const setProperty = vi.fn((name: string, value: string) => {
    properties.set(name, value);
  });
  const datasetWrites = vi.fn<(key: PropertyKey, value: unknown) => void>();
  const dataset = new Proxy<Record<string, string>>(
    { timelineLabelLeft: String(left), timelineLabelWidth: String(width) },
    {
      set(target, key, value) {
        datasetWrites(key, value);
        return Reflect.set(target, key, value);
      },
    },
  );
  const geometry = vi.fn(() => {
    throw new Error('Scroll updater must not force a DOM geometry read.');
  });
  const element = {
    dataset,
    style: { setProperty },
    getBoundingClientRect: geometry,
  } as unknown as HTMLElement;
  const label: TimelineLabel = { element, left, width };
  return { label, element, properties, setProperty, datasetWrites, geometry };
}
function value(f: ReturnType<typeof fixture>, name: string) {
  return Number.parseFloat(f.properties.get(name) ?? 'NaN');
}

describe('Timeline native sticky label registry', () => {
  it('collects all rendered labels and parses exact fractional bar geometry once', () => {
    const first = fixture(128.5, 400.25),
      second = fixture(-40, 10);
    const querySelectorAll = vi.fn(() => [first.element, second.element]);
    const root = { querySelectorAll } as unknown as ParentNode;
    const registry = collectTimelineLabels(root);
    expect(querySelectorAll).toHaveBeenCalledExactlyOnceWith(
      '[data-timeline-label]',
    );
    expect(registry).toEqual([
      { element: first.element, left: 128.5, width: 400.25 },
      { element: second.element, left: -40, width: 10 },
    ]);
    syncTimelineLabels(registry, 0, 1000, 0);
    syncTimelineLabels(registry, 100, 1000, 0);
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
  });
  it('refreshes changed React bar geometry only when the registry is recollected', () => {
    const f = fixture(0, 1000);
    const root = {
      querySelectorAll: () => [f.element],
    } as unknown as ParentNode;
    const first = collectTimelineLabels(root);
    f.element.dataset.timelineLabelLeft = '200';
    f.element.dataset.timelineLabelWidth = '400';
    expect(first[0]).toMatchObject({ left: 0, width: 1000 });
    expect(collectTimelineLabels(root)[0]).toMatchObject({
      left: 200,
      width: 400,
    });
  });
  it('handles an empty registry without DOM work', () => {
    expect(() => syncTimelineLabels([], 200, 1000, 240)).not.toThrow();
    expect(
      collectTimelineLabels({
        querySelectorAll: () => [],
      } as unknown as ParentNode),
    ).toEqual([]);
  });
});

describe('Timeline exact native-scroll width updates', () => {
  it('keeps title width inside both the visible viewport and the owning bar', () => {
    const f = fixture(0, 800);
    syncTimelineLabels([f.label], 200, 400, 0);
    expect(value(f, '--timeline-label-width')).toBe(384);
    expect(f.element.dataset.timelineLinkFit).toBe('true');
    expect(f.geometry).not.toHaveBeenCalled();
    expect([...f.properties.keys()].sort()).toEqual([
      '--timeline-label-width',
      '--timeline-popup-shift',
    ]);
  });
  it.each([
    { remaining: 10, width: 0, fits: false },
    { remaining: 20, width: 4, fits: false },
    { remaining: 39, width: 23, fits: false },
    { remaining: 40, width: 24, fits: true },
    { remaining: 80, width: 64, fits: true },
  ])(
    'clips the last $remaining pixels of a long Task accurately',
    ({ remaining, width, fits }) => {
      const f = fixture(0, 1000);
      syncTimelineLabels([f.label], 1000 - remaining, 1000, 0);
      expect(value(f, '--timeline-label-width')).toBe(width);
      expect(f.element.dataset.timelineLinkFit).toBe(String(fits));
    },
  );
  it('updates fractional-pixel clipping directly without waiting for a React bucket', () => {
    const f = fixture(0, 1000);
    syncTimelineLabels([f.label], 900, 1000, 0);
    expect(value(f, '--timeline-label-width')).toBe(84);
    syncTimelineLabels([f.label], 900.5, 1000, 0);
    expect(value(f, '--timeline-label-width')).toBe(83.5);
  });
  it('makes no DOM writes across hundreds of scroll pixels in the middle of a long bar', () => {
    const f = fixture(0, 5000);
    syncTimelineLabels([f.label], 100, 1000, 0);
    f.setProperty.mockClear();
    f.datasetWrites.mockClear();
    for (let scroll = 101; scroll < 1100; ++scroll)
      syncTimelineLabels([f.label], scroll, 1000, 0);
    expect(f.setProperty).not.toHaveBeenCalled();
    expect(f.datasetWrites).not.toHaveBeenCalled();
    expect(f.geometry).not.toHaveBeenCalled();
  });
  it('writes only the width while clipping changes without changing link-fit or popup alignment', () => {
    const f = fixture(0, 1000);
    syncTimelineLabels([f.label], 900, 1000, 0);
    f.setProperty.mockClear();
    f.datasetWrites.mockClear();
    syncTimelineLabels([f.label], 901, 1000, 0);
    expect(f.setProperty).toHaveBeenCalledExactlyOnceWith(
      '--timeline-label-width',
      '83px',
    );
    expect(f.datasetWrites).not.toHaveBeenCalled();
  });
  it('hides both completely offscreen and too-small bars', () => {
    const fixtures = [fixture(0, 100), fixture(900, 100), fixture(210, 10)];
    syncTimelineLabels(
      fixtures.map((f) => f.label),
      200,
      400,
      0,
    );
    for (const f of fixtures) {
      expect(value(f, '--timeline-label-width')).toBe(0);
      expect(f.element.dataset.timelineLinkFit).toBe('false');
      expect(f.geometry).not.toHaveBeenCalled();
    }
  });
  it('changes link-fit at its exact 24px threshold and restores it on reverse scrolling', () => {
    const f = fixture(0, 60);
    syncTimelineLabels([f.label], 20, 1000, 0);
    expect(value(f, '--timeline-label-width')).toBe(24);
    expect(f.element.dataset.timelineLinkFit).toBe('true');
    syncTimelineLabels([f.label], 21, 1000, 0);
    expect(value(f, '--timeline-label-width')).toBe(23);
    expect(f.element.dataset.timelineLinkFit).toBe('false');
    syncTimelineLabels([f.label], 20, 1000, 0);
    expect(f.element.dataset.timelineLinkFit).toBe('true');
  });
  it('retains the direct quick-link fit on a one-day Week Task', () => {
    const f = fixture(0, 42);
    syncTimelineLabels([f.label], 0, 1000, 0);
    expect(value(f, '--timeline-label-width')).toBe(26);
    expect(f.element.dataset.timelineLinkFit).toBe('true');
  });
  it('deducts the sticky outline from available chart width exactly once', () => {
    const open = fixture(0, 5000),
      closed = fixture(0, 5000);
    syncTimelineLabels([open.label], 200, 640, 240);
    syncTimelineLabels([closed.label], 200, 400, 0);
    expect(value(open, '--timeline-label-width')).toBe(384);
    expect(open.properties).toEqual(closed.properties);
  });
  it('refreshes label metrics when the viewport or outline is resized without scrolling', () => {
    const f = fixture(0, 5000);
    syncTimelineLabels([f.label], 200, 1000, 240);
    expect(value(f, '--timeline-label-width')).toBe(744);
    syncTimelineLabels([f.label], 200, 1000, 300);
    expect(value(f, '--timeline-label-width')).toBe(684);
    syncTimelineLabels([f.label], 200, 1200, 300);
    expect(value(f, '--timeline-label-width')).toBe(884);
  });
  it('handles a fully covered chart without exposing text or direct links', () => {
    const f = fixture(0, 1000);
    syncTimelineLabels([f.label], 0, 200, 240);
    expect(value(f, '--timeline-label-width')).toBe(0);
    expect(f.element.dataset.timelineLinkFit).toBe('false');
  });
});

describe('Timeline link popup alignment', () => {
  it.each([0, 240])(
    'keeps a right-edge popup inside the chart with outline width %i',
    (outline) => {
      const f = fixture(900, 500);
      syncTimelineLabels([f.label], 0, 1000 + outline, outline);
      const anchor = 908,
        popupLeft = anchor + value(f, '--timeline-popup-shift');
      expect(popupLeft).toBe(736);
      expect(popupLeft).toBeGreaterThanOrEqual(8);
      expect(popupLeft + 256).toBeLessThanOrEqual(992);
    },
  );
  it('anchors an ordinary popup to its current visible native-sticky start', () => {
    const f = fixture(0, 5000);
    syncTimelineLabels([f.label], 1000, 1000, 0);
    expect(value(f, '--timeline-popup-shift')).toBe(0);
  });
  it('changes popup alignment when the right-edge Task enters the viewport', () => {
    const f = fixture(900, 500);
    syncTimelineLabels([f.label], 0, 1000, 0);
    expect(value(f, '--timeline-popup-shift')).toBe(-172);
    syncTimelineLabels([f.label], 200, 1000, 0);
    expect(value(f, '--timeline-popup-shift')).toBe(0);
  });
});
