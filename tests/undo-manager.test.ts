import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptsUndoShortcut,
  configureUndo,
  recordUndo,
  resetUndo,
  undoHeaders,
  undoLast,
  undoSnapshot,
  readSettledPlanning,
} from '../lib/undo-manager';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  resetUndo(crypto.randomUUID());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
describe('Undo mutation lane', () => {
  it('cancels a pending read when the account changes', async () => {
    const gate = deferred();
    const reader = vi.fn(async () => {
      await gate.promise;
      return 'account A';
    });
    const result = readSettledPlanning(reader);
    const rejected = expect(result).rejects.toThrow(/Account changed/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetUndo('account B');
    gate.resolve();
    await rejected;
    expect(reader).toHaveBeenCalledOnce();
  });
  it('clears earlier history when the latest operation has no usable Undo receipt', async () => {
    const apply = vi.fn();
    configureUndo({ ready: async () => true, apply });
    await recordUndo('old edit', async () => {});
    configureUndo({ ready: async () => false, apply });
    await recordUndo('large group', async () => {});
    expect(undoSnapshot()).toMatchObject({
      available: false,
      error: expect.stringContaining('Earlier Undo history was cleared'),
    });
    await undoLast();
    expect(apply).not.toHaveBeenCalled();
  });
  it('retries an Undo-triggered reload if a newer mutation completes during the read', async () => {
    configureUndo({ ready: async () => true, apply: async () => {} });
    const gate = deferred();
    let value = 'old';
    let reads = 0;
    const result = readSettledPlanning(async () => {
      const snapshot = value;
      if (++reads === 1) await gate.promise;
      return snapshot;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await recordUndo('new edit', async () => {
      value = 'new';
    });
    gate.resolve();
    expect(await result).toBe('new');
    expect(reads).toBe(2);
  });
  it('serializes unsupported writes without borrowing another command header', async () => {
    const gate = deferred();
    let header: Record<string, string> = {};
    const calls: string[] = [];
    configureUndo({
      ready: async () => true,
      apply: async () => {
        calls.push('undo');
      },
    });
    const first = recordUndo('change', async () => {
      calls.push('start');
      expect(undoHeaders()['x-myplan-undo-operation']).toBeTruthy();
      await gate.promise;
      calls.push('end');
    });
    const second = recordUndo(
      'create',
      async () => {
        header = undoHeaders();
        calls.push('create');
      },
      false,
    );
    await Promise.resolve();
    expect(undoSnapshot().busy).toBe(true);
    await undoLast();
    expect(calls).not.toContain('undo');
    gate.resolve();
    await Promise.all([first, second]);
    expect(header).toEqual({});
    expect(calls).toEqual(['start', 'end', 'create']);
    await undoLast();
    expect(calls.at(-1)).toBe('undo');
    expect(undoSnapshot().available).toBe(false);
  });
  it('cancels queued edits on account switch and never applies old Undo to the new account', async () => {
    const gate = deferred();
    const queued = vi.fn();
    const oldApply = vi.fn();
    const newApply = vi.fn();
    configureUndo({ ready: async () => true, apply: oldApply });
    const first = recordUndo('edit', async () => {
      await gate.promise;
    });
    const second = recordUndo('queued', queued);
    const rejection = expect(second).rejects.toThrow(/Account changed/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetUndo('different account');
    configureUndo({ ready: async () => true, apply: newApply });
    gate.resolve();
    await first;
    await rejection;
    await undoLast();
    expect(queued).not.toHaveBeenCalled();
    expect(oldApply).not.toHaveBeenCalled();
    expect(newApply).not.toHaveBeenCalled();
    expect(undoSnapshot().available).toBe(false);
  });
  it('retains a failed Undo for retry and does not announce success', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('Undo conflict'))
      .mockResolvedValueOnce(undefined);
    configureUndo({ ready: async () => true, apply });
    await recordUndo('edit', async () => {});
    await undoLast();
    expect(undoSnapshot()).toMatchObject({
      available: true,
      error: 'Undo conflict',
    });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    await undoLast();
    expect(undoSnapshot()).toMatchObject({ available: false, error: '' });
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });
  it('limits history and clears it at a permanent-delete boundary', async () => {
    const apply = vi.fn();
    configureUndo({ ready: async () => true, apply });
    for (let i = 0; i < 25; i++) await recordUndo(`edit ${i}`, async () => {});
    for (let i = 0; i < 25; i++) await undoLast();
    expect(apply).toHaveBeenCalledTimes(20);
    await recordUndo('edit', async () => {});
    await recordUndo('delete', async () => {}, false, true);
    expect(undoSnapshot().available).toBe(false);
  });
});
describe('Ctrl/Cmd+Z ownership', () => {
  const event = {
    key: 'z',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
  };
  it('accepts only Undo, not redo, composition or key repeats', () => {
    expect(acceptsUndoShortcut(event, [])).toBe(true);
    expect(
      acceptsUndoShortcut({ ...event, ctrlKey: false, metaKey: true }, []),
    ).toBe(true);
    for (const patch of [
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { altKey: true },
      { defaultPrevented: true },
      { ctrlKey: false },
      { key: 'x' },
    ])
      expect(acceptsUndoShortcut({ ...event, ...patch }, [])).toBe(false);
  });
  it('leaves native text Undo to text fields, including children in a composed path', () => {
    class ElementStub {
      constructor(
        public isContentEditable = false,
        private input = false,
      ) {}
      matches() {
        return this.input;
      }
    }
    vi.stubGlobal('HTMLElement', ElementStub);
    expect(
      acceptsUndoShortcut(event, [
        new ElementStub(false, true) as unknown as EventTarget,
      ]),
    ).toBe(false);
    expect(
      acceptsUndoShortcut(event, [
        new ElementStub() as unknown as EventTarget,
        new ElementStub(true) as unknown as EventTarget,
      ]),
    ).toBe(false);
    expect(
      acceptsUndoShortcut(event, [new ElementStub() as unknown as EventTarget]),
    ).toBe(true);
  });
});
