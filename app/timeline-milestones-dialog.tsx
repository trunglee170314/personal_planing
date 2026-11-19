'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Flag, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { openPlanningEditor } from '@/components/planning-editor';
import type { TimelineWorkspace } from '@/lib/data/repository';
import { milestoneAgenda, type AgendaPeriod } from '@/lib/milestone-agenda';

const PERIODS: { value: AgendaPeriod; label: string }[] = [
  { value: 'this-week', label: 'This week' },
  { value: 'next-week', label: 'Next week' },
  { value: 'this-month', label: 'This month' },
  { value: 'next-month', label: 'Next month' },
  { value: 'all', label: 'All' },
];
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function TimelineMilestonesDialog({
  workspace,
  disabled,
  onGoToDate,
}: {
  workspace: TimelineWorkspace;
  disabled: boolean;
  onGoToDate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<AgendaPeriod>('this-week');
  const [query, setQuery] = useState('');
  const [importantOnly, setImportantOnly] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const pendingAction = useRef<{
    kind: 'navigate' | 'edit';
    id: string;
  } | null>(null);
  const suppressRestore = useRef(false);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);
  const items = useMemo(
    () => milestoneAgenda(workspace, { period, now, query, importantOnly }),
    [workspace, period, now, query, importantOnly],
  );
  function closeThen(action: { kind: 'navigate' | 'edit'; id: string }) {
    suppressRestore.current = true;
    pendingAction.current = action;
    setOpen(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) {
          suppressRestore.current = false;
          setNow(new Date());
        }
        setOpen(value);
      }}
      onOpenChangeComplete={(value) => {
        if (value) return;
        const action = pendingAction.current;
        pendingAction.current = null;
        if (action?.kind === 'navigate') onGoToDate(action.id);
        else if (action)
          openPlanningEditor({ kind: 'milestone', id: action.id });
      }}
    >
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        <Flag aria-hidden="true" /> Milestones
      </DialogTrigger>
      <DialogContent
        className="max-h-[85dvh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-2xl"
        finalFocus={() => !suppressRestore.current}
      >
        <DialogHeader className="pr-7">
          <DialogTitle>Milestones</DialogTitle>
          <DialogDescription>
            All active goals and tasks, including Inbox. Weeks run Monday–Sunday
            in Vietnam time. All includes past milestones.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <fieldset
            aria-label="Milestone period"
            className="flex flex-wrap gap-1"
          >
            {PERIODS.map(({ value, label }) => (
              <Button
                key={value}
                size="sm"
                variant={period === value ? 'default' : 'outline'}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              aria-label="Search milestones"
              placeholder="Find milestone, goal or task…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={importantOnly}
                onChange={(event) => setImportantOnly(event.target.checked)}
              />
              Important only
            </label>
          </div>
          <output className="block text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? 'milestone' : 'milestones'}
          </output>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {items.length ? (
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.milestone.id} className="rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    {item.milestone.is_important ? (
                      <Star
                        className="mt-0.5 size-4 shrink-0 fill-current"
                        aria-label="Important"
                      />
                    ) : (
                      <Flag
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <strong className="block break-words text-sm">
                        {item.milestone.title}
                      </strong>
                      <time
                        className="text-sm"
                        dateTime={item.milestone.milestone_on}
                      >
                        {DATE_FORMAT.format(
                          new Date(`${item.milestone.milestone_on}T00:00:00Z`),
                        )}
                      </time>
                      <p className="break-words text-xs text-muted-foreground">
                        {item.goal?.title ?? 'Inbox — no goal'}
                        {item.task ? ` · ${item.task.title}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        closeThen({ kind: 'navigate', id: item.milestone.id })
                      }
                    >
                      Go to date
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        closeThen({ kind: 'edit', id: item.milestone.id })
                      }
                    >
                      Edit
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No milestones match these filters.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
