'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  deleteAnnotation,
  listAnnotations,
  saveAnnotation,
  type Annotation,
  type AnnotationTarget,
} from '@/lib/data/workspace-extras';
import { announceDataChanged } from '@/lib/data/data-events';

export function ItemAnnotations({
  target,
  links = true,
}: {
  target: AnnotationTarget;
  links?: boolean;
}) {
  const [rows, setRows] = useState<Annotation[]>([]);
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'comment' | 'link'>('comment');
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => listAnnotations(target).then(setRows);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setRows([]);
      setBody('');
      setUrl('');
      setEditing(undefined);
      setError('');
    }, 0);
    void listAnnotations({ kind: target.kind, id: target.id })
      .then((data) => {
        if (active) {
          window.clearTimeout(timer);
          setRows(data);
          setBody('');
          setUrl('');
          setEditing(undefined);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [target.kind, target.id]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await saveAnnotation(
        target,
        { kind, body, url: kind === 'link' ? url : null },
        editing,
      );
      await refresh();
      setBody('');
      setUrl('');
      setEditing(undefined);
      announceDataChanged('annotations');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label="Comments and links"
    >
      <h3 className="text-sm font-semibold">
        Comments{links ? ' & links' : ''}
      </h3>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="max-h-64 space-y-3 overflow-y-auto">
        {rows.map((row) => (
          <article key={row.id} className="rounded-lg border p-3 text-sm">
            {row.kind === 'link' && row.url ? (
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline"
              >
                {row.body}
              </a>
            ) : (
              <p className="whitespace-pre-wrap break-words">{row.body}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <time>{new Date(row.created_at).toLocaleString()}</time>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(row.id);
                  setKind(row.kind);
                  setBody(row.body);
                  setUrl(row.url ?? '');
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm('Delete this comment/link?')) return;
                  setBusy(true);
                  try {
                    await deleteAnnotation(row.id);
                    await refresh();
                    announceDataChanged('annotations');
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : 'Could not delete.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      {links && (
        <select
          aria-label="Comment or link"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'comment' | 'link')}
          className="rounded-lg border bg-background p-2 text-sm"
        >
          <option value="comment">Comment</option>
          <option value="link">Link</option>
        </select>
      )}
      <textarea
        aria-label={kind === 'link' ? 'Link label' : 'Comment'}
        value={body}
        maxLength={10000}
        onChange={(e) => setBody(e.target.value)}
        placeholder={kind === 'link' ? 'Link label' : 'Write a comment…'}
        className="min-h-20 w-full rounded-lg border bg-background p-3 text-sm"
      />
      {kind === 'link' && (
        <input
          aria-label="Link URL"
          type="url"
          value={url}
          maxLength={2048}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
        />
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => void save()}
        >
          {editing ? 'Update' : 'Add'} {kind}
        </Button>
        {editing && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setEditing(undefined);
              setBody('');
              setUrl('');
            }}
          >
            Cancel edit
          </Button>
        )}
      </div>
    </section>
  );
}
