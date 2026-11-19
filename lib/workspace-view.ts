export function normalizeSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
export function matchesSearch(
  query: string,
  ...values: Array<string | null | undefined>
) {
  const haystack = normalizeSearch(values.filter(Boolean).join(' '));
  return normalizeSearch(query)
    .trim()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
export function preserveItemOrder<T extends { id: string }>(
  previous: T[],
  next: T[],
) {
  const byId = new Map(next.map((item) => [item.id, item]));
  const oldIds = new Set(previous.map((item) => item.id));
  return [
    ...previous.flatMap((item) =>
      byId.has(item.id) ? [byId.get(item.id)!] : [],
    ),
    ...next.filter((item) => !oldIds.has(item.id)),
  ];
}
export const MILESTONE_LANE_HEIGHT = 32;
type MilestoneMarker = {
  id: string;
  milestone_on: string;
  title?: string;
  is_important?: boolean;
};
/** Match the rendered marker, including labels. Normal flags fit their day at
 * close scales; preserve a readable minimum at overview scales. Legacy callers
 * without a scale retain the original 24px width. */
export function milestoneMarkerWidth(
  item: Pick<MilestoneMarker, 'title' | 'is_important'>,
  dayWidth?: number,
) {
  if (dayWidth !== undefined && (!Number.isFinite(dayWidth) || dayWidth <= 0))
    throw new Error('Invalid timeline scale.');
  if (!item.is_important)
    return dayWidth === undefined
      ? 24
      : Math.min(24, Math.max(10, dayWidth - 4));
  const textWidth = Array.from(item.title ?? '').reduce(
    (width, char) => width + (char.codePointAt(0)! > 0x2ff ? 14 : 8),
    0,
  );
  return Math.min(220, Math.max(80, 40 + textWidth));
}
export function milestoneLevels(items: MilestoneMarker[], dayWidth: number) {
  const ends: number[] = [];
  const result = new Map<string, number>();
  for (const item of [...items].sort(
    (a, b) =>
      a.milestone_on.localeCompare(b.milestone_on) || a.id.localeCompare(b.id),
  )) {
    const x =
      (Date.parse(`${item.milestone_on}T00:00:00Z`) / 86400000) * dayWidth;
    let level = ends.findIndex((end) => end <= x);
    if (level < 0) level = ends.length;
    ends[level] = x + milestoneMarkerWidth(item) + 4;
    result.set(item.id, level);
  }
  return result;
}

export type MilestoneCluster<T extends MilestoneMarker> = {
  items: T[];
  day: string;
  width: number;
  /** Center normal flags in their day; labels/counts retain the day-edge anchor. */
  offset: number;
};
/** One marker lane: cluster only colliding pixel footprints at the current zoom.
 * A compact count replaces overlapping labels, so a long Important title does
 * not pull every later marker into one giant transitive cluster. */
export function clusterMilestones<T extends MilestoneMarker>(
  items: T[],
  dayWidth: number,
): MilestoneCluster<T>[] {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0)
    throw new Error('Invalid timeline scale.');
  const clusters: MilestoneCluster<T>[] = [];
  const pixel = (day: string) =>
    (Date.parse(`${day}T00:00:00Z`) / 86400000) * dayWidth;
  for (const item of [...items].sort(
    (a, b) =>
      a.milestone_on.localeCompare(b.milestone_on) || a.id.localeCompare(b.id),
  )) {
    const width = milestoneMarkerWidth(item, dayWidth);
    clusters.push({
      items: [item],
      day: item.milestone_on,
      width,
      offset: item.is_important ? 0 : Math.max(0, (dayWidth - width) / 2),
    });
    // A count is wider than a normal flag and returns to the day-edge anchor.
    // Recheck the preceding cluster too when this changes its occupied bounds.
    while (clusters.length > 1) {
      const current = clusters.at(-1)!;
      const previous = clusters[clusters.length - 2];
      if (
        pixel(current.day) + current.offset >=
        pixel(previous.day) + previous.offset + previous.width + 4
      )
        break;
      previous.items.push(...current.items);
      previous.width = Math.max(
        48,
        32 + String(previous.items.length).length * 8,
      );
      previous.offset = 0;
      clusters.pop();
    }
  }
  return clusters;
}
