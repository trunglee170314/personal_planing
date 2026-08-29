import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  allowPlanningPointer,
  guardPlanningPointer,
  ownsPlanningPointer,
} from '../lib/pointer-actions';

describe('Calendar/Timeline primary-button gestures', () => {
  it('ignores secondary move/up/cancel while the primary gesture stays active', () => {
    const active = { pointerId: 1 };
    for (const event of [{ pointerId: 2 }, { pointerId: 3 }])
      expect(ownsPlanningPointer(event, active)).toBe(false);
    expect(ownsPlanningPointer({ pointerId: 1 }, active)).toBe(true);
    expect(ownsPlanningPointer({ pointerId: 1 }, null)).toBe(false);
  });
  it.each([1, 2, 3, 4])(
    'blocks mouse button %i without cancelling native scrolling',
    (button) => {
      const event = {
        button,
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      };
      guardPlanningPointer(event);
      expect(allowPlanningPointer(event)).toBe(false);
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );
  it('allows the left button and primary touch, not secondary contacts', () => {
    expect(allowPlanningPointer({ button: 0 })).toBe(true);
    expect(allowPlanningPointer({ button: 0, isPrimary: true })).toBe(true);
    expect(allowPlanningPointer({ button: 0, isPrimary: false })).toBe(false);
  });
  it.each(['calendar-grid-v2', 'timeline-panel-v2'])(
    '%s guards all descendant pointer actions at capture',
    (component) => {
      const source = readFileSync(
        new URL(`../app/${component}.tsx`, import.meta.url),
        'utf8',
      );
      expect(source).toContain('onPointerDownCapture={guardPlanningPointer}');
    },
  );
});
