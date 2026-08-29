import {
  planningBreadcrumb,
  type PlanningContext,
} from '@/lib/planning-context';

export function PlanningBreadcrumb({
  context,
  className = '',
}: {
  context: PlanningContext;
  className?: string;
}) {
  const text = planningBreadcrumb(context);
  return text ? (
    <span
      className={`block truncate text-xs text-muted-foreground ${className}`}
      title={text}
      aria-label={`Planning context: ${text}`}
    >
      {text}
    </span>
  ) : null;
}
