'use client';
import type { WeeklyInsights } from '@/lib/insights';
import { Button } from './ui/button';

export function InsightsSummary({
  insights,
  loading,
  error,
  onOpen,
  title = 'This week at a glance',
}: {
  insights: WeeklyInsights | null;
  loading: boolean;
  error?: string;
  onOpen: () => void;
  title?: string;
}) {
  return (
    <section
      aria-label="Weekly insights summary"
      className="mt-5 rounded-2xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>
          View Insights
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : loading || !insights ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Loading weekly insights…
        </p>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="mt-3 flex w-full flex-wrap gap-x-6 gap-y-2 rounded-lg p-1 text-left text-sm hover:bg-muted"
        >
          <span>
            <strong>{insights.done.length}</strong> Done
          </span>
          <span>
            <strong>{insights.notNeeded.length}</strong> Not needed
          </span>
          <span>
            <strong>{insights.open.length}</strong> Open
          </span>
          <span className={insights.overdue.length ? 'text-destructive' : ''}>
            <strong>{insights.overdue.length}</strong> Overdue within Open
          </span>
        </button>
      )}
    </section>
  );
}
