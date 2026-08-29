'use client';
import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import {
  resetUndo,
  subscribeUndo,
  undoLast,
  undoSnapshot,
} from '@/lib/undo-manager';
import { useKeyboard, useShortcutActions } from './keyboard-shortcuts';
export function UndoControl({
  scope,
  hidden = false,
}: {
  scope: string;
  hidden?: boolean;
}) {
  const keyboard = useKeyboard();
  const [state, setState] = useState(undoSnapshot);
  useEffect(() => {
    const unsubscribe = subscribeUndo(() => setState(undoSnapshot()));
    resetUndo(scope);
    return () => {
      unsubscribe();
      resetUndo('');
    };
  }, [scope]);
  useShortcutActions({
    undo: {
      run: () => {
        void undoLast();
      },
      enabled: () =>
        !hidden && undoSnapshot().available && !undoSnapshot().busy,
    },
  });
  if (hidden) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
      <output className="text-xs text-destructive">{state.error}</output>
      <button
        type="button"
        disabled={!state.available || state.busy}
        onClick={() => void undoLast()}
        title={
          state.label
            ? `Undo ${state.label} (${keyboard?.preferences.undo ?? 'Mod+Z'})`
            : 'Undo recent edits. Permanent delete is excluded.'
        }
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs disabled:opacity-40"
      >
        <Undo2 className="size-4" />
        Undo
      </button>
    </div>
  );
}
