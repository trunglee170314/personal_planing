export type CalendarLaneItem = {
  id: string;
  start: number;
  end: number;
};

export type CalendarLane = {
  lane: number;
  laneCount: number;
};

export function layoutCalendarLanes(
  items: readonly CalendarLaneItem[],
): Map<string, CalendarLane> {
  const result = new Map<string, CalendarLane>();
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  let groupEnd = Number.NEGATIVE_INFINITY;
  let laneEnds: number[] = [];
  let group: Array<{ id: string; lane: number }> = [];

  function finishGroup() {
    const laneCount = Math.max(1, laneEnds.length);
    for (const item of group)
      result.set(item.id, { lane: item.lane, laneCount });
    laneEnds = [];
    group = [];
    groupEnd = Number.NEGATIVE_INFINITY;
  }

  for (const item of sorted) {
    const end = Math.max(item.end, item.start + 1);
    if (group.length > 0 && item.start >= groupEnd) finishGroup();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    groupEnd = Math.max(groupEnd, end);
    group.push({ id: item.id, lane });
  }
  if (group.length > 0) finishGroup();
  return result;
}
