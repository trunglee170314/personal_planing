import { visibleTimelineLabel } from './timeline-interactions';

export type TimelineLabel = {
  element: HTMLElement;
  left: number;
  width: number;
  lastWidth?: number;
  lastFit?: boolean;
  lastPopupShift?: number;
};

/** Refresh the registry only after React changes the rendered bars. */
export function collectTimelineLabels(
  root: Pick<ParentNode, 'querySelectorAll'>,
): TimelineLabel[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-timeline-label]'),
    (element) => ({
      element,
      left: Number(element.dataset.timelineLabelLeft),
      width: Number(element.dataset.timelineLabelWidth),
    }),
  );
}

/** Native sticky owns X position. Only available width changes on scroll, without
 * a React render, DOM geometry queries, or a second animation-frame delay. */
export function syncTimelineLabels(
  labels: TimelineLabel[],
  scrollLeft: number,
  viewportWidth: number,
  outlineWidth: number,
) {
  const chartWidth = Math.max(0, viewportWidth - outlineWidth);
  for (const label of labels) {
    const visible = visibleTimelineLabel(
      label.left,
      label.width,
      scrollLeft,
      chartWidth,
    );
    const width = visible?.width ?? 0;
    const fits = width >= 24;
    const anchor = Math.max(label.left + 8, scrollLeft + 8);
    const popupLeft = Math.max(
      scrollLeft + 8,
      Math.min(anchor, scrollLeft + chartWidth - 264),
    );
    const popupShift = popupLeft - anchor;
    if (width !== label.lastWidth) {
      label.element.style.setProperty('--timeline-label-width', `${width}px`);
      label.lastWidth = width;
    }
    if (fits !== label.lastFit) {
      label.element.dataset.timelineLinkFit = String(fits);
      label.lastFit = fits;
    }
    if (popupShift !== label.lastPopupShift) {
      label.element.style.setProperty(
        '--timeline-popup-shift',
        `${popupShift}px`,
      );
      label.lastPopupShift = popupShift;
    }
  }
}
