'use client';
type UndoCommand = { operation: string; session: string; label: string };
type Adapter = {
  ready: (command: UndoCommand) => Promise<boolean>;
  apply: (command: UndoCommand) => Promise<void>;
};
let adapter: Adapter | null = null;
let session = '';
let account = '';
let epoch = 0;
let current: UndoCommand | null = null;
let pending = 0;
let replaying = false;
let queue = Promise.resolve();
let error = '';
let revision = 0;
const history: UndoCommand[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export function configureUndo(next: Adapter) {
  adapter = next;
}
export function resetUndo(scope: string) {
  if (account === scope) return;
  epoch++;
  revision++;
  account = scope;
  session = crypto.randomUUID();
  history.length = 0;
  error = '';
  emit();
}
export function undoHeaders(): Record<string, string> {
  return current && !replaying
    ? {
        'x-myplan-undo-operation': current.operation,
        'x-myplan-undo-session': current.session,
      }
    : {};
}
export function subscribeUndo(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function undoSnapshot() {
  return {
    available: history.length > 0,
    busy: pending > 0 || replaying,
    label: history.at(-1)?.label ?? '',
    error,
  };
}
export async function readSettledPlanning<T>(
  read: () => Promise<T>,
): Promise<T> {
  const scope = epoch;
  for (;;) {
    await queue;
    if (scope !== epoch)
      throw new Error('Account changed. This load was cancelled.');
    const version = revision;
    const result = await read();
    if (scope !== epoch)
      throw new Error('Account changed. This load was cancelled.');
    if (version === revision && !pending && !replaying) return result;
  }
}
export async function recordUndo<T>(
  label: string,
  action: () => Promise<T>,
  undoable = true,
  invalidate = false,
): Promise<T> {
  if (!session || !adapter) return action();
  const generation = epoch,
    capturedSession = session,
    capturedAdapter = adapter;
  pending++;
  revision++;
  emit();
  const execution = queue
    .catch(() => undefined)
    .then(async () => {
      const command = {
        operation: crypto.randomUUID(),
        session: capturedSession,
        label,
      };
      try {
        if (generation !== epoch)
          throw new Error('Account changed. This queued change was cancelled.');
        current = undoable ? command : null;
        if (invalidate) history.length = 0;
        const result = await action();
        current = null;
        if (undoable && generation === epoch) {
          try {
            const ready = await capturedAdapter.ready(command);
            if (generation === epoch) {
              if (ready) {
                history.push(command);
                while (history.length > 20) history.shift();
                error = '';
              } else {
                history.length = 0;
                error =
                  'Saved without an Undo record. Earlier Undo history was cleared to avoid undoing the wrong action.';
              }
            }
          } catch {
            if (generation === epoch) {
              history.length = 0;
              error =
                'Saved, but Undo could not be prepared. Earlier Undo history was cleared. Check the connection and database migration.';
            }
          }
        }
        return result;
      } finally {
        current = null;
        pending--;
        emit();
      }
    });
  queue = execution.then(
    () => undefined,
    () => undefined,
  );
  return execution;
}
export function invalidateUndo() {
  history.length = 0;
  emit();
}
export async function undoLast() {
  if (pending || replaying || !adapter) return;
  const command = history.at(-1);
  if (!command) return;
  const generation = epoch,
    capturedAdapter = adapter;
  replaying = true;
  revision++;
  error = '';
  emit();
  const execution = queue
    .catch(() => undefined)
    .then(async () => {
      try {
        if (generation !== epoch)
          throw new Error('Account changed. Undo was cancelled.');
        await capturedAdapter.apply(command);
        if (generation === epoch) {
          history.pop();
          window.dispatchEvent(
            new CustomEvent('myplan:data-changed', {
              detail: { source: 'undo' },
            }),
          );
        }
      } catch (cause) {
        if (generation === epoch)
          error =
            cause instanceof Error
              ? cause.message
              : 'Undo failed. No changes were restored.';
      } finally {
        replaying = false;
        emit();
      }
    });
  queue = execution;
  await execution;
}
export function acceptsUndoShortcut(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'shiftKey'
    | 'repeat'
    | 'isComposing'
    | 'defaultPrevented'
  >,
  path: EventTarget[],
) {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== 'z' ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing ||
    event.defaultPrevented
  )
    return false;
  return !path.some(
    (target) =>
      typeof HTMLElement !== 'undefined' &&
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.matches(
          'input,textarea,select,[contenteditable],[role=textbox],[role=searchbox],[role=spinbutton]',
        )),
  );
}
