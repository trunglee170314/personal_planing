'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcutActions } from '@/components/keyboard-shortcuts';
import { matchesSearch } from '@/lib/workspace-view';
import { InsightsSummary } from '@/components/insights-summary';
import { useInsightsWorkspace } from '@/components/use-insights-workspace';
import {
  buildWeeklyInsights,
  insightDay,
  insightMidnight,
  insightWeek,
} from '@/lib/insights';
import { vietnamDateKey } from '@/lib/calendar';
import { MYPLAN_DATA_CHANGED } from '@/lib/data/data-events';
import { readSettledPlanning } from '@/lib/undo-manager';
import {
  BookOpenCheck,
  CheckCircle2,
  LoaderCircle,
  Save,
  Target,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getErrorMessage,
  getPlanningRepository,
  type ReviewStats,
  type WeeklyReview,
} from '@/lib/data/repository';

function formatWeek(weekStart: string) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

export function ReviewsPanel({
  initialWeek,
  onOpenInsights,
}: { initialWeek?: string; onOpenInsights?: (week: string) => void } = {}) {
  const repository = getPlanningRepository();
  const insightWorkspace = useInsightsWorkspace();
  const reviewForm = useRef<HTMLFormElement>(null);
  const draftDirty = useRef(false);
  const loadVersion = useRef(0);
  useShortcutActions({
    create: {
      run: () => reviewForm.current?.querySelector('textarea')?.focus(),
    },
    edit: { run: () => reviewForm.current?.querySelector('textarea')?.focus() },
  });
  const currentWeek = useMemo(
    () => insightWeek(initialWeek ?? vietnamDateKey(new Date())),
    [initialWeek],
  );
  const insights = useMemo(
    () =>
      insightWorkspace.workspace
        ? buildWeeklyInsights(
            insightWorkspace.workspace,
            currentWeek,
            insightWorkspace.now,
          )
        : null,
    [insightWorkspace.workspace, currentWeek, insightWorkspace.now],
  );
  const [query, setQuery] = useState('');
  const [reviews, setReviews] = useState<WeeklyReview[]>([]);
  const [stats, setStats] = useState<ReviewStats>({
    completedTasks: 0,
    openTasks: 0,
    activeGoals: 0,
  });
  const [wins, setWins] = useState('');
  const [challenges, setChallenges] = useState('');
  const [nextWeekFocus, setNextWeekFocus] = useState('');
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const loadReviews = useCallback(async () => {
    if (!repository) return;
    const version = ++loadVersion.current;
    setLoading(true);
    const monday = insightMidnight(currentWeek);
    const nextMonday = insightMidnight(insightDay(currentWeek, 7));
    try {
      const workspace = await readSettledPlanning(() =>
        repository.getReviewsWorkspace(
          monday.toISOString(),
          nextMonday.toISOString(),
        ),
      );
      if (version !== loadVersion.current) return;
      setReviews(workspace.reviews);
      setStats(workspace.stats);
      const current = workspace.reviews.find(
        (review) => review.week_start === currentWeek,
      );
      if (current && !draftDirty.current) {
        setWins(current.wins);
        setChallenges(current.challenges);
        setNextWeekFocus(current.next_week_focus);
        setSatisfaction(current.satisfaction);
      }
    } catch (error) {
      if (version === loadVersion.current) setMessage(getErrorMessage(error));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [currentWeek, repository]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadReviews(), 0);
    const sync = () => void loadReviews();
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => {
      loadVersion.current++;
      window.clearTimeout(handle);
      window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
    };
  }, [loadReviews]);

  async function saveReview(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!repository) return;
    setSaving(true);
    setMessage('');
    const input = {
      week_start: currentWeek,
      wins: wins.trim(),
      challenges: challenges.trim(),
      next_week_focus: nextWeekFocus.trim(),
      satisfaction,
    };
    try {
      await repository.saveWeeklyReview(input);
      setReviews((current) => {
        const existing = current.find(
          (review) => review.week_start === currentWeek,
        );
        const saved: WeeklyReview = {
          id: existing?.id ?? currentWeek,
          ...input,
          updated_at: new Date().toISOString(),
        };
        return existing
          ? current.map((review) =>
              review.week_start === currentWeek ? saved : review,
            )
          : [saved, ...current];
      });
    } catch (error) {
      setSaving(false);
      setMessage(getErrorMessage(error));
      return;
    }
    setSaving(false);
  }

  return (
    <section aria-labelledby="reviews-heading">
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
          Pause, learn, adjust
        </p>
        <h1
          id="reviews-heading"
          className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
        >
          Reviews
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Reflect on the current week, then choose what deserves your attention
          next.
        </p>
      </div>

      {onOpenInsights && (
        <InsightsSummary
          title="Selected week at a glance"
          insights={insights}
          loading={insightWorkspace.loading}
          error={insightWorkspace.error}
          onOpen={() => onOpenInsights(currentWeek)}
        />
      )}
      <div
        className="mt-6 grid gap-3 sm:grid-cols-3"
        title="Task status is separate from checklist outcomes; Task completion may include work resolved as Not needed."
      >
        <Card size="sm">
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Tasks completed in selected week
            </p>
            <p className="mt-2 flex items-center gap-2 text-2xl font-semibold">
              <CheckCircle2 className="size-5 text-primary" />
              {stats.completedTasks}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <p className="text-xs text-muted-foreground">Open Tasks now</p>
            <p className="mt-2 text-2xl font-semibold">{stats.openTasks}</p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <p className="text-xs text-muted-foreground">Active Goals now</p>
            <p className="mt-2 flex items-center gap-2 text-2xl font-semibold">
              <Target className="size-5 text-primary" />
              {stats.activeGoals}
            </p>
          </CardContent>
        </Card>
      </div>

      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted px-4 py-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}

      <Card className="mt-5 border bg-card shadow-sm">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">
                Week of {formatWeek(currentWeek)}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Saving again updates this week’s review.
              </p>
            </div>
            <Badge variant="outline">Selected week</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <form
            ref={reviewForm}
            className="grid gap-5"
            onChangeCapture={() => {
              draftDirty.current = true;
            }}
            onSubmit={saveReview}
          >
            <label className="text-xs font-semibold">
              What went well?
              <textarea
                value={wins}
                onChange={(event) => setWins(event.target.value)}
                rows={3}
                placeholder="Record progress, decisions, or moments worth repeating."
                className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="text-xs font-semibold">
              What was difficult?
              <textarea
                value={challenges}
                onChange={(event) => setChallenges(event.target.value)}
                rows={3}
                placeholder="Capture friction, blockers, or lessons learned."
                className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="text-xs font-semibold">
              What is the focus for next week?
              <textarea
                value={nextWeekFocus}
                onChange={(event) => setNextWeekFocus(event.target.value)}
                rows={3}
                placeholder="Choose the outcome or behavior that matters most."
                className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <fieldset>
              <legend className="text-xs font-semibold">
                How satisfied are you with this week?
              </legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {[1, 2, 3, 4, 5].map((score) => (
                  <Button
                    key={score}
                    type="button"
                    variant={satisfaction === score ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={satisfaction === score}
                    onClick={() => {
                      draftDirty.current = true;
                      setSatisfaction(score);
                    }}
                  >
                    {score}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div>
              <Button type="submit" disabled={saving}>
                {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
                Save review
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-5 border bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Review history</CardTitle>
          <input
            type="search"
            aria-label="Search review history"
            data-shortcut-search
            placeholder="Search date, wins or notes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mt-3 rounded-lg border bg-background p-2 text-sm"
          />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid min-h-40 place-items-center">
              <LoaderCircle className="size-6 animate-spin text-primary" />
              <span className="sr-only">Loading reviews</span>
            </div>
          ) : reviews.length === 0 ? (
            <div className="grid min-h-48 place-items-center text-center">
              <div>
                <BookOpenCheck className="mx-auto size-8 text-primary" />
                <h2 className="mt-4 font-semibold">No saved reviews yet</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Complete the form above to create your first weekly review.
                </p>
              </div>
            </div>
          ) : (
            <div>
              {reviews
                .filter((review) =>
                  matchesSearch(
                    query,
                    review.week_start,
                    review.wins,
                    review.challenges,
                    review.next_week_focus,
                  ),
                )
                .map((review) => (
                  <article
                    key={review.id}
                    className="border-b py-4 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="font-semibold">
                        {formatWeek(review.week_start)}
                      </h2>
                      {review.satisfaction ? (
                        <Badge variant="outline">{review.satisfaction}/5</Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {review.next_week_focus ||
                        review.wins ||
                        review.challenges ||
                        'Saved without notes.'}
                    </p>
                  </article>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
