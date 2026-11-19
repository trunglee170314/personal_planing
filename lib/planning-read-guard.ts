export function planningReadDisposition(
  startedEpoch: number,
  currentEpoch: number,
  pending: number,
) {
  if (pending > 0) return 'defer' as const;
  return startedEpoch === currentEpoch
    ? ('apply' as const)
    : ('reload' as const);
}

/** Only the latest request from the currently mounted consumer may commit. */
export function createPlanningReadGuard() {
  let revision = 0;
  let mounted = false;
  return {
    mount() {
      mounted = true;
      revision++;
    },
    begin() {
      const token = ++revision;
      return () => mounted && token === revision;
    },
    dispose() {
      mounted = false;
      revision++;
    },
  };
}
