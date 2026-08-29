'use client';
import { ExternalLink } from 'lucide-react';
import { safeTaskLink, type TaskLinkSource } from '../lib/task-links';

export function TaskLink({
  task,
  compact = true,
  className = '',
}: {
  task?: TaskLinkSource | null;
  compact?: boolean;
  className?: string;
}) {
  const url = safeTaskLink(task);
  if (!url || !task) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open task link: ${task.title}`}
      title={`${task.link_label?.trim() || task.title} — ${url}`}
      data-shortcut-action="openLink"
      className={`inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded p-1 text-xs hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${className}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      {!compact ? 'Open task link' : null}
    </a>
  );
}
