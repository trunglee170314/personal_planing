'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  CalendarDays,
  LoaderCircle,
  Plus,
  Target,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  getErrorMessage,
  getPlanningRepository,
  type Goal,
} from '@/lib/data/repository';

export function GoalsPanel() {
  const repository = getPlanningRepository();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [message, setMessage] = useState('');

  const loadGoals = useCallback(async () => {
    if (!repository) return;
    setLoading(true);
    try {
      setGoals(await repository.listGoals());
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadGoals(), 0);
    return () => window.clearTimeout(handle);
  }, [loadGoals]);

  async function createGoal(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!repository || !title.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      await repository.createGoal({
        title: title.trim(),
        description: description.trim() || null,
        starts_on: startsOn || null,
        ends_on: endsOn || null,
      });
    } catch (error) {
      setSaving(false);
      setMessage(getErrorMessage(error));
      return;
    }
    setSaving(false);
    setTitle('');
    setDescription('');
    setStartsOn('');
    setEndsOn('');
    setShowForm(false);
    setMessage('Goal created. You can now connect tasks to it.');
    await loadGoals();
  }

  async function updateProgress(goal: Goal, progress: number) {
    if (!repository) return;
    const completed = progress === 100;
    try {
      await repository.updateGoal(goal.id, {
        progress,
        status: completed ? 'completed' : 'active',
        completed_at: completed ? new Date().toISOString() : null,
      });
      setGoals((items) =>
        items.map((item) =>
          item.id === goal.id
            ? { ...item, progress, status: completed ? 'completed' : 'active' }
            : item,
        ),
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }

  async function archiveGoal(goal: Goal) {
    if (!repository) return;
    try {
      await repository.updateGoal(goal.id, {
        status: 'archived',
        archived_at: new Date().toISOString(),
      });
      setGoals((items) => items.filter((item) => item.id !== goal.id));
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }

  return (
    <section aria-labelledby="goals-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-primary">
            Direction before motion
          </p>
          <h1
            id="goals-heading"
            className="text-3xl font-semibold tracking-[-.04em] md:text-[42px]"
          >
            Goals
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Define the outcomes that matter, then connect daily tasks to them.
          </p>
        </div>
        <Button size="lg" onClick={() => setShowForm((value) => !value)}>
          <Plus />
          {showForm ? 'Close form' : 'Create goal'}
        </Button>
      </div>

      {showForm ? (
        <Card className="mt-7 border bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Set a new goal</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 md:grid-cols-2" onSubmit={createGoal}>
              <label className="text-xs font-semibold md:col-span-2">
                Goal title
                <input
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Build a calmer work system"
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs font-semibold md:col-span-2">
                Why this matters
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Describe the outcome and what success looks like."
                  rows={3}
                  className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs font-semibold">
                Start date
                <input
                  type="date"
                  value={startsOn}
                  onChange={(event) => setStartsOn(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs font-semibold">
                Target date
                <input
                  type="date"
                  min={startsOn || undefined}
                  value={endsOn}
                  onChange={(event) => setEndsOn(event.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <div className="md:col-span-2">
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Target />
                  )}
                  Save goal
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <p
          className="mt-4 rounded-xl border bg-muted px-4 py-3 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}

      {loading ? (
        <div className="grid min-h-[260px] place-items-center">
          <LoaderCircle className="size-6 animate-spin text-primary" />
          <span className="sr-only">Loading goals</span>
        </div>
      ) : goals.length === 0 ? (
        <Card className="mt-7 border bg-card shadow-sm">
          <CardContent className="grid min-h-[300px] place-items-center text-center">
            <div>
              <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
                <Target />
              </span>
              <h2 className="mt-5 text-lg font-semibold">
                Your first goal starts here
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                Create one clear outcome. You can add tasks and adjust progress
                afterward.
              </p>
              <Button className="mt-5" onClick={() => setShowForm(true)}>
                <Plus />
                Create goal
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-7 grid gap-4 lg:grid-cols-2">
          {goals.map((goal) => (
            <Card key={goal.id} className="border bg-card shadow-sm">
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <Badge variant="outline" className="mb-3 capitalize">
                    {goal.status}
                  </Badge>
                  <CardTitle className="text-lg leading-snug">
                    {goal.title}
                  </CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Archive ${goal.title}`}
                  onClick={() => void archiveGoal(goal)}
                >
                  <Archive />
                </Button>
              </CardHeader>
              <CardContent>
                <p className="min-h-10 text-sm leading-relaxed text-muted-foreground">
                  {goal.description || 'No description yet.'}
                </p>
                {goal.ends_on ? (
                  <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarDays className="size-4" />
                    Target{' '}
                    {new Date(`${goal.ends_on}T00:00:00`).toLocaleDateString()}
                  </p>
                ) : null}
                <div className="mt-5 flex items-center justify-between text-xs">
                  <span>Progress</span>
                  <strong>{goal.progress}%</strong>
                </div>
                <Progress
                  value={goal.progress}
                  className="mt-2"
                  aria-label={`${goal.title} progress: ${goal.progress} percent`}
                />
                <input
                  className="mt-4 w-full accent-[var(--primary)]"
                  aria-label={`Update progress for ${goal.title}`}
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={goal.progress}
                  onChange={(event) =>
                    void updateProgress(goal, Number(event.target.value))
                  }
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
