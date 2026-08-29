'use client';
import { readSettledPlanning } from '@/lib/undo-manager';
import {
  useWorkspaceList,
  WorkspaceListTools,
} from '@/components/workspace-list-tools';

import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Target,
  Trash2,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { goalColorValue, goalColors } from '@/lib/colors';
import {
  getErrorMessage,
  getPlanningRepository,
  type Goal,
  type GoalColor,
  type LifecycleView,
} from '@/lib/data/repository';
import { announceDataChanged } from '@/lib/data/data-events';
import { MYPLAN_DATA_CHANGED } from '@/lib/data/data-events';

const viewCopy: Record<LifecycleView, { label: string; empty: string }> = {
  active: { label: 'Active', empty: 'No active goals yet.' },
  archived: { label: 'Archived', empty: 'No archived goals.' },
  trash: { label: 'Trash', empty: 'Goal trash is empty.' },
};

export function GoalsPanel({
  initialView = 'active',
  initialQuery = '',
}: { initialView?: LifecycleView; initialQuery?: string } = {}) {
  const repository = getPlanningRepository();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [view, setView] = useState<LifecycleView>(initialView);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [editingTaskCount, setEditingTaskCount] = useState(0);
  const [colorKey, setColorKey] = useState<GoalColor>('jade');
  const [message, setMessage] = useState('');
  const [permanentDelete, setPermanentDelete] = useState<Goal | null>(null);
  const mutationVersionsRef = useRef(new Map<string, number>());
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const sourceRef = useRef('goals');
  const loadRequestRef = useRef(0);
  const formRef = useRef<HTMLDivElement>(null);
  const listing = useWorkspaceList(
    goals,
    `goals:${view}`,
    (item) => item.title,
    (item) => `${item.title} ${item.description ?? ''}`,
    (item) => item.ends_on ?? '',
    initialQuery,
  );

  useEffect(() => {
    if (!showForm || !editingId) return;
    const frame = window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      });
      const titleInput = formRef.current?.querySelector<HTMLInputElement>(
        'input[name="goal-title"]',
      );
      titleInput?.focus({ preventScroll: true });
      titleInput?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingId, showForm]);

  function nextMutationVersion(id: string) {
    const version = (mutationVersionsRef.current.get(id) ?? 0) + 1;
    mutationVersionsRef.current.set(id, version);
    return version;
  }

  async function enqueueMutation(id: string, action: () => Promise<void>) {
    const previous = mutationQueuesRef.current.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    mutationQueuesRef.current.set(id, next);
    try {
      await next;
    } finally {
      if (mutationQueuesRef.current.get(id) === next)
        mutationQueuesRef.current.delete(id);
    }
  }

  const loadGoals = useCallback(
    async (silent = false) => {
      if (!repository) return;
      const request = ++loadRequestRef.current;
      if (!silent) setLoading(true);
      try {
        const next = await readSettledPlanning(() =>
          repository.listGoals(view),
        );
        if (request === loadRequestRef.current) setGoals(next);
      } catch (error) {
        if (request === loadRequestRef.current)
          setMessage(getErrorMessage(error));
      } finally {
        if (request === loadRequestRef.current && !silent) setLoading(false);
      }
    },
    [repository, view],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => void loadGoals(), 0);
    return () => window.clearTimeout(handle);
  }, [loadGoals]);
  useEffect(() => {
    const sync = (event: Event) => {
      if ((event as CustomEvent).detail?.source !== 'goals')
        void loadGoals(true);
    };
    window.addEventListener(MYPLAN_DATA_CHANGED, sync);
    return () => window.removeEventListener(MYPLAN_DATA_CHANGED, sync);
  }, [loadGoals]);

  function resetForm() {
    setEditingId(null);
    setTitle('');
    setDescription('');
    setStartsOn('');
    setEndsOn('');
    setEditingTaskCount(0);
    setColorKey('jade');
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
    setMessage('');
  }

  function startEdit(goal: Goal) {
    setEditingId(goal.id);
    setTitle(goal.title);
    setDescription(goal.description ?? '');
    setStartsOn(goal.starts_on ?? '');
    setEndsOn(goal.ends_on ?? '');
    setEditingTaskCount(goal.task_count);
    setColorKey(goal.color_key);
    setShowForm(true);
    setMessage('');
  }

  function closeForm() {
    resetForm();
    setShowForm(false);
  }

  async function saveGoal(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository || !title.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || null,
        starts_on: startsOn || null,
        ends_on: endsOn || null,
        color_key: colorKey,
      };
      if (editingId) {
        const id = editingId;
        const previous = goals.find((goal) => goal.id === id);
        const fields = Object.keys(input) as Array<keyof Goal>;
        const versions = new Map(
          fields.map((field) => [field, nextMutationVersion(`${id}:${field}`)]),
        );
        setGoals((items) =>
          items.map((goal) => (goal.id === id ? { ...goal, ...input } : goal)),
        );
        closeForm();
        try {
          await enqueueMutation(id, () => repository.updateGoal(id, input));
          announceDataChanged(sourceRef.current);
        } catch (error) {
          if (previous)
            setGoals((items) =>
              items.map((goal) => {
                if (goal.id !== id) return goal;
                const rollback = { ...goal };
                for (const field of fields)
                  if (
                    mutationVersionsRef.current.get(`${id}:${field}`) ===
                    versions.get(field)
                  )
                    Object.assign(rollback, { [field]: previous[field] });
                return rollback;
              }),
            );
          throw error;
        }
      } else {
        const id = await repository.createGoal(input);
        setGoals((items) => [
          {
            id,
            ...input,
            progress: 0,
            status: 'active',
            archived_at: null,
            deleted_at: null,
            task_count: 0,
            completed_task_count: 0,
          },
          ...items,
        ]);
        closeForm();
        announceDataChanged(sourceRef.current);
      }
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function changeGoal(
    goal: Goal,
    changes: Parameters<NonNullable<typeof repository>['updateGoal']>[1],
    _success: string,
  ) {
    if (!repository) return;
    setMessage('');
    const fields = Object.keys(changes) as Array<keyof Goal>;
    const versions = new Map(
      fields.map((field) => [
        field,
        nextMutationVersion(`${goal.id}:${field}`),
      ]),
    );
    const index = goals.findIndex((item) => item.id === goal.id);
    const nextGoal = { ...goal, ...changes };
    const remainsInView =
      view === 'trash'
        ? Boolean(nextGoal.deleted_at)
        : view === 'archived'
          ? nextGoal.status === 'archived' && !nextGoal.deleted_at
          : nextGoal.status !== 'archived' && !nextGoal.deleted_at;
    setGoals((items) =>
      remainsInView
        ? items.map((item) => (item.id === goal.id ? nextGoal : item))
        : items.filter((item) => item.id !== goal.id),
    );
    try {
      await enqueueMutation(goal.id, () =>
        repository.updateGoal(goal.id, changes),
      );
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setGoals((items) => {
        const existing = items.find((item) => item.id === goal.id);
        if (!existing) {
          const latest = fields.every(
            (field) =>
              mutationVersionsRef.current.get(`${goal.id}:${field}`) ===
              versions.get(field),
          );
          if (!latest) return items;
          const insertAt = Math.max(0, Math.min(index, items.length));
          return [...items.slice(0, insertAt), goal, ...items.slice(insertAt)];
        }
        const rollback = { ...existing };
        for (const field of fields)
          if (
            mutationVersionsRef.current.get(`${goal.id}:${field}`) ===
            versions.get(field)
          )
            Object.assign(rollback, { [field]: goal[field] });
        return items.map((item) => (item.id === goal.id ? rollback : item));
      });
      setMessage(getErrorMessage(error));
    }
  }

  async function permanentlyDeleteGoal() {
    if (!repository || !permanentDelete) return;
    const target = permanentDelete;
    const index = goals.findIndex((goal) => goal.id === target.id);
    setSaving(true);
    setMessage('');
    setGoals((items) => items.filter((goal) => goal.id !== target.id));
    setPermanentDelete(null);
    try {
      await repository.deleteGoal(target.id);
      announceDataChanged(sourceRef.current);
    } catch (error) {
      setGoals((items) => [
        ...items.slice(0, Math.max(index, 0)),
        target,
        ...items.slice(Math.max(index, 0)),
      ]);
      setMessage(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="goals-heading">
      <WorkspaceListTools {...listing} groupLabel="Goal" />
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
            Edit freely, archive finished context, or use Trash for recoverable
            removal.
          </p>
        </div>
        <Button size="lg" onClick={showForm ? closeForm : startCreate}>
          <Plus />
          {showForm ? 'Close form' : 'Create goal'}
        </Button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" aria-label="Goal views">
        {(Object.keys(viewCopy) as LifecycleView[]).map((item) => (
          <Button
            key={item}
            type="button"
            variant={view === item ? 'default' : 'outline'}
            onClick={() => {
              closeForm();
              setView(item);
            }}
          >
            {viewCopy[item].label}
          </Button>
        ))}
      </div>

      {showForm ? (
        <div ref={formRef} className="scroll-mt-6">
          <GoalForm
            editing={Boolean(editingId)}
            automatic={editingTaskCount > 0}
            taskCount={editingTaskCount}
            saving={saving}
            title={title}
            setTitle={setTitle}
            description={description}
            setDescription={setDescription}
            startsOn={startsOn}
            setStartsOn={setStartsOn}
            endsOn={endsOn}
            setEndsOn={setEndsOn}
            colorKey={colorKey}
            setColorKey={setColorKey}
            onSubmit={saveGoal}
            onCancel={closeForm}
          />
        </div>
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
          <CardContent className="grid min-h-[260px] place-items-center text-center">
            <div>
              <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
                {view === 'archived' ? (
                  <Archive />
                ) : view === 'trash' ? (
                  <Trash2 />
                ) : (
                  <Target />
                )}
              </span>
              <h2 className="mt-5 text-lg font-semibold">
                {viewCopy[view].empty}
              </h2>
              {view === 'active' ? (
                <Button className="mt-5" onClick={startCreate}>
                  <Plus />
                  Create goal
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-7 grid gap-4 lg:grid-cols-2">
          {listing.visible.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              view={view}
              onEdit={startEdit}
              onArchive={(item) =>
                changeGoal(
                  item,
                  { status: 'archived', archived_at: new Date().toISOString() },
                  'Goal archived. Its history is preserved.',
                )
              }
              onRestoreArchive={(item) =>
                changeGoal(
                  item,
                  { status: 'active', archived_at: null },
                  'Goal restored to Active.',
                )
              }
              onTrash={(item) =>
                changeGoal(
                  item,
                  { deleted_at: new Date().toISOString() },
                  'Goal moved to Trash. Linked tasks are preserved.',
                )
              }
              onRestoreTrash={(item) =>
                changeGoal(
                  item,
                  { deleted_at: null },
                  item.status === 'archived'
                    ? 'Goal restored to Archived.'
                    : 'Goal restored to Active.',
                )
              }
              onPermanentDelete={setPermanentDelete}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={Boolean(permanentDelete)}
        onOpenChange={(open) => {
          if (!open) setPermanentDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete this goal?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Child goals will move to the top level,
              linked tasks will move to Inbox, and existing calendar blocks will
              remain as unlinked history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={() => void permanentlyDeleteGoal()}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type GoalFormProps = {
  editing: boolean;
  automatic: boolean;
  taskCount: number;
  saving: boolean;
  title: string;
  setTitle: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  startsOn: string;
  setStartsOn: (value: string) => void;
  endsOn: string;
  setEndsOn: (value: string) => void;
  colorKey: GoalColor;
  setColorKey: (value: GoalColor) => void;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onCancel: () => void;
};

function GoalForm(props: GoalFormProps) {
  return (
    <Card className="mt-7 border bg-card shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">
          {props.editing ? 'Edit goal' : 'Set a new goal'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={props.onSubmit}>
          <label className="text-xs font-semibold md:col-span-2">
            Goal title
            <input
              name="goal-title"
              required
              value={props.title}
              onChange={(event) => props.setTitle(event.target.value)}
              placeholder="Build a calmer work system"
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="text-xs font-semibold md:col-span-2">
            Why this matters
            <textarea
              value={props.description}
              onChange={(event) => props.setDescription(event.target.value)}
              placeholder="Describe the outcome and what success looks like."
              rows={3}
              className="mt-2 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="text-xs font-semibold">
            Start date
            <input
              type="date"
              min="2000-01-01"
              max="2200-12-31"
              value={props.startsOn}
              onChange={(event) => props.setStartsOn(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Deadline
            <input
              type="date"
              min={props.startsOn || '2000-01-01'}
              max="2200-12-31"
              value={props.endsOn}
              onChange={(event) => props.setEndsOn(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
            />
          </label>
          <fieldset className="md:col-span-2">
            <legend className="text-xs font-semibold">Goal color</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {goalColors.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  title={color.name}
                  aria-label={`Use ${color.name}`}
                  aria-pressed={props.colorKey === color.id}
                  onClick={() => props.setColorKey(color.id)}
                  className={`grid size-10 place-items-center rounded-full ${props.colorKey === color.id ? 'ring-2 ring-ring ring-offset-2 ring-offset-background' : ''}`}
                >
                  <span
                    className="size-6 rounded-full border-2 border-card"
                    style={{ background: color.value }}
                  />
                </button>
              ))}
            </div>
          </fieldset>
          {props.editing ? (
            <p className="rounded-xl border bg-muted px-4 py-3 text-xs text-muted-foreground md:col-span-2">
              {props.automatic
                ? `Progress and status are calculated automatically from ${props.taskCount} linked task${props.taskCount === 1 ? '' : 's'}.`
                : 'Link at least one Task to calculate this Goal progress automatically.'}
            </p>
          ) : null}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={props.saving}>
              {props.saving ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Target />
              )}
              {props.editing ? 'Save changes' : 'Save goal'}
            </Button>
            {props.editing ? (
              <Button type="button" variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

type GoalCardProps = {
  goal: Goal;
  view: LifecycleView;
  onEdit: (goal: Goal) => void;
  onArchive: (goal: Goal) => void;
  onRestoreArchive: (goal: Goal) => void;
  onTrash: (goal: Goal) => void;
  onRestoreTrash: (goal: Goal) => void;
  onPermanentDelete: (goal: Goal) => void;
};

function GoalCard({
  goal,
  view,
  onEdit,
  onArchive,
  onRestoreArchive,
  onTrash,
  onRestoreTrash,
  onPermanentDelete,
}: GoalCardProps) {
  return (
    <Card
      className="border bg-card shadow-sm"
      style={{
        borderLeftWidth: 5,
        borderLeftColor: goalColorValue(goal.color_key),
      }}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <Badge variant="outline" className="mb-3 capitalize">
            {view === 'trash' ? 'trash' : goal.status}
          </Badge>
          <CardTitle className="text-lg leading-snug">
            <button
              type="button"
              className="text-left hover:text-primary"
              onClick={() => onEdit(goal)}
            >
              {goal.title}
            </button>
          </CardTitle>
        </div>
        <div className="flex shrink-0 gap-1">
          {view !== 'trash' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${goal.title}`}
              onClick={() => onEdit(goal)}
            >
              <Pencil />
            </Button>
          ) : null}
          {view === 'active' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${goal.title}`}
              onClick={() => onArchive(goal)}
            >
              <Archive />
            </Button>
          ) : null}
          {view === 'archived' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Restore ${goal.title} from archive`}
              onClick={() => onRestoreArchive(goal)}
            >
              <ArchiveRestore />
            </Button>
          ) : null}
          {view !== 'trash' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${goal.title} to trash`}
              onClick={() => onTrash(goal)}
            >
              <Trash2 />
            </Button>
          ) : null}
          {view === 'trash' ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Restore ${goal.title} from trash`}
                onClick={() => onRestoreTrash(goal)}
              >
                <RotateCcw />
              </Button>
              <Button
                variant="destructive"
                size="icon-sm"
                aria-label={`Permanently delete ${goal.title}`}
                onClick={() => onPermanentDelete(goal)}
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <p className="min-h-10 text-sm leading-relaxed text-muted-foreground">
          {goal.description || 'No description yet.'}
        </p>
        {goal.ends_on ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarDays className="size-4" />
            Deadline {new Date(`${goal.ends_on}T00:00:00`).toLocaleDateString()}
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
        {goal.task_count > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {goal.completed_task_count}/{goal.task_count} tasks completed ·
            automatic
          </p>
        ) : view === 'active' ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No Tasks linked yet · progress stays at 0%
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
