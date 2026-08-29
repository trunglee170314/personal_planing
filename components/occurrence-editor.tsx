'use client';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { ItemAnnotations } from './item-annotations';
import {
  getPlanningRepository,
  getErrorMessage,
  type CalendarSession,
} from '@/lib/data/repository';
import { toLocalInput, vietnamInputToIso } from '@/lib/calendar';
import { announceDataChanged } from '@/lib/data/data-events';
export type EditableOccurrence = CalendarSession & { occurrence_start: string };
/** This editor uses the displayed override, retaining the original recurrence key. */
export function OccurrenceEditor({
  item,
  onClose,
  onEditSeries,
}: {
  item: EditableOccurrence;
  onClose: () => void;
  onEditSeries: () => void;
}) {
  const [start, setStart] = useState(() => toLocalInput(item.starts_at));
  const [end, setEnd] = useState(() => toLocalInput(item.ends_at));
  const [outcome, setOutcome] = useState(
    item.completed_at ? 'done' : item.not_needed_at ? 'skipped' : 'open',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const repo = getPlanningRepository();
    if (!repo) return;
    setBusy(true);
    setError('');
    try {
      const startsAt = vietnamInputToIso(start),
        endsAt =
          item.item_type === 'reminder'
            ? new Date(new Date(startsAt).getTime() + 15 * 60000).toISOString()
            : vietnamInputToIso(end);
      if (new Date(endsAt) <= new Date(startsAt))
        throw new Error('End must be after start.');
      await repo.updateCalendarOccurrence(item.id, item.occurrence_start, {
        override_starts_at: startsAt,
        override_ends_at: endsAt,
        completed_at:
          outcome === 'done'
            ? (item.completed_at ?? new Date().toISOString())
            : null,
        not_needed_at:
          outcome === 'skipped'
            ? (item.not_needed_at ?? new Date().toISOString())
            : null,
      });
      announceDataChanged('occurrence-editor');
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item.title} · This occurrence</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Only this occurrence will change. The other dates in the repeating
          series stay unchanged.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(event) => void save(event)}
          className="grid gap-4 sm:grid-cols-2"
        >
          <label className="text-sm">
            {item.item_type === 'reminder' ? 'Reminder time' : 'Start'}
            <input
              className="mt-1 w-full rounded-lg border bg-background p-2"
              required
              type="datetime-local"
              value={start}
              min="2000-01-01T00:00"
              max="2200-12-31T23:59"
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          {item.item_type === 'checklist' ? (
            <label className="text-sm">
              End
              <input
                className="mt-1 w-full rounded-lg border bg-background p-2"
                required
                type="datetime-local"
                value={end}
                min={start}
                max="2200-12-31T23:59"
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          ) : null}
          <label className="text-sm sm:col-span-2">
            Status
            <select
              className="ml-3 rounded-lg border bg-background p-2"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            >
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="skipped">Not needed</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <ItemAnnotations target={{ kind: 'calendar', id: item.id }} />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onEditSeries}
            >
              Edit entire series…
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save this occurrence'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
