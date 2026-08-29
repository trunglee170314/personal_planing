'use client';
import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import {
  acceptsUndoShortcut,
  resetUndo,
  subscribeUndo,
  undoLast,
  undoSnapshot,
} from '@/lib/undo-manager';
export function UndoControl({ scope }: { scope: string }) {
  const [state, setState] = useState(undoSnapshot);
  useEffect(() => {
    const unsubscribe = subscribeUndo(() => setState(undoSnapshot()));
    resetUndo(scope);
    return () => {
      unsubscribe();
      resetUndo('');
    };
  }, [scope]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = undoSnapshot();
      if (
        current.available &&
        !current.busy &&
        acceptsUndoShortcut(event, event.composedPath())
      ) {
        event.preventDefault();
        void undoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
      <output className="text-xs text-destructive">{state.error}</output>
      <button
        type="button"
        disabled={!state.available || state.busy}
        onClick={() => void undoLast()}
        title={
          state.label
            ? `Undo ${state.label} (Ctrl+Z)`
            : 'Undo recent edits (Ctrl+Z). Permanent delete is excluded.'
        }
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs disabled:opacity-40"
      >
        <Undo2 className="size-4" />
        Undo
      </button>
    </div>
  );
}
