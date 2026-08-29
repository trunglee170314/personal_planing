'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  listHolidays,
  saveHoliday,
  deleteHoliday,
  type Holiday,
} from '@/lib/data/workspace-extras';
import { announceDataChanged } from '@/lib/data/data-events';

export function HolidaySettings() {
  const [items, setItems] = useState<Holiday[]>([]);
  const [draft, setDraft] = useState({ title: '', starts_on: '', ends_on: '' });
  const [id, setId] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => listHolidays().then(setItems);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="w-full space-y-4 rounded-2xl border bg-card p-5">
      <h2 className="text-lg font-semibold">Holidays & days off</h2>
      <p className="text-sm text-muted-foreground">
        Highlight days off on Timeline. Existing schedules are not moved.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-3 border-b pb-2 text-sm"
        >
          <span className="flex-1">
            {item.title} · {item.starts_on} → {item.ends_on}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(item);
              setId(item.id);
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Remove this day-off highlight?')) return;
              setBusy(true);
              try {
                await deleteHoliday(item.id);
                await refresh();
                announceDataChanged('holidays');
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not remove.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          Name
          <input
            value={draft.title}
            maxLength={200}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
          />
        </label>
        <label className="text-sm">
          From
          <input
            type="date"
            value={draft.starts_on}
            onChange={(e) =>
              setDraft({
                ...draft,
                starts_on: e.target.value,
                ends_on: draft.ends_on || e.target.value,
              })
            }
            className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
          />
        </label>
        <label className="text-sm">
          Through
          <input
            type="date"
            value={draft.ends_on}
            onChange={(e) => setDraft({ ...draft, ends_on: e.target.value })}
            className="mt-1 h-10 w-full rounded-lg border bg-background px-3"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await saveHoliday(draft, id);
              await refresh();
              setDraft({ title: '', starts_on: '', ends_on: '' });
              setId(undefined);
              announceDataChanged('holidays');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not save.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {id ? 'Save' : 'Add day off'}
        </Button>
        {id && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setId(undefined);
              setDraft({ title: '', starts_on: '', ends_on: '' });
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
