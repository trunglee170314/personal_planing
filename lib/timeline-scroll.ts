export const TIMELINE_HORIZONTAL_BUCKET = 128;
export const TIMELINE_VERTICAL_BUCKET = 80;
export const TIMELINE_SCROLL_OVERSCAN = 240;

export type TimelineViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function nonnegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * React needs coarse windows for culling, not every native scroll pixel.
 * Dimensions remain exact so resizing inside a bucket still refreshes layout.
 * Labels use the actual native scroll position independently of this snapshot.
 */
export function quantizeTimelineViewport(
  viewport: TimelineViewport,
): TimelineViewport {
  return {
    left:
      Math.floor(nonnegative(viewport.left) / TIMELINE_HORIZONTAL_BUCKET) *
      TIMELINE_HORIZONTAL_BUCKET,
    top:
      Math.floor(nonnegative(viewport.top) / TIMELINE_VERTICAL_BUCKET) *
      TIMELINE_VERTICAL_BUCKET,
    width: nonnegative(viewport.width),
    height: nonnegative(viewport.height),
  };
}

/**
 * End-exclusive calendar column window. A pixel minimum covers the complete
 * uncommitted bucket even at Year scale, where 30 days are only 90 pixels.
 */
export function timelineDayWindow(
  rangeDays: number,
  dayWidth: number,
  left: number,
  width: number,
) {
  if (
    !Number.isInteger(rangeDays) ||
    rangeDays < 0 ||
    !Number.isFinite(dayWidth) ||
    dayWidth <= 0
  )
    throw new RangeError('Invalid Timeline day window geometry.');
  const overscan = Math.max(TIMELINE_SCROLL_OVERSCAN, dayWidth * 30);
  const start = nonnegative(left);
  const first = Math.min(
    rangeDays,
    Math.max(0, Math.floor((start - overscan) / dayWidth)),
  );
  const end = Math.min(
    rangeDays,
    Math.max(
      first,
      Math.ceil((start + nonnegative(width) + overscan) / dayWidth),
    ),
  );
  return { first, end };
}
