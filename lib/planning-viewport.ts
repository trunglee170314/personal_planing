/** Put Today one third into the visible chart, excluding the sticky outline. */
export function timelineTodayScrollLeft(
  todayOffset: number,
  viewportWidth: number,
  outlineWidth: number,
) {
  return Math.max(
    0,
    todayOffset - Math.max(0, viewportWidth - outlineWidth) / 3,
  );
}

export function mapEdgeEmphasis(
  source: string,
  target: string,
  activeNodeId: string | null,
  selected: boolean,
): 'hover' | 'selected' | 'dim' | 'normal' {
  if (activeNodeId === source || activeNodeId === target) return 'hover';
  if (selected) return 'selected';
  return activeNodeId ? 'dim' : 'normal';
}
