/** Mouse buttons are not modifiers for planning actions. Keep middle/right
 * gestures available to the browser; never prevent their default scrolling. */
export function allowPlanningPointer(event: {
  button: number;
  isPrimary?: boolean;
}) {
  return event.button === 0 && event.isPrimary !== false;
}

export function guardPlanningPointer(event: {
  button: number;
  isPrimary?: boolean;
  stopPropagation(): void;
}) {
  if (!allowPlanningPointer(event)) event.stopPropagation();
}

export function ownsPlanningPointer(
  event: { pointerId: number },
  gesture: { pointerId: number } | null,
) {
  return gesture !== null && event.pointerId === gesture.pointerId;
}
