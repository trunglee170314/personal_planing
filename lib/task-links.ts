export type TaskLinkSource = {
  title: string;
  link_url: string | null;
  link_label?: string | null;
};

/** Only navigation URLs are allowed, including for imported or legacy tasks. */
export function safeTaskLink(task?: TaskLinkSource | null) {
  if (!task?.link_url) return null;
  try {
    const url = new URL(task.link_url);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
