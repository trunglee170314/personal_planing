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
export function milestoneLevels(
  items: Array<{ id: string; milestone_on: string }>,
  dayWidth: number,
) {
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
    ends[level] = x + 28;
    result.set(item.id, level);
  }
  return result;
}
