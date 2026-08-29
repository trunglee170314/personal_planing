'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  getErrorMessage,
  getPlanningRepository,
  type CalendarWorkspace,
} from '@/lib/data/repository';
import { MYPLAN_DATA_CHANGED } from '@/lib/data/data-events';
import { readSettledPlanning } from '@/lib/undo-manager';

export function useInsightsWorkspace() {
  const repository = getPlanningRepository();
  const [workspace, setWorkspace] = useState<CalendarWorkspace | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let active = true,
      request = 0;
    const load = async () => {
      const version = ++request;
      setLoading(true);
      setError('');
      try {
        if (!repository) throw new Error('Workspace is unavailable.');
        const next = await readSettledPlanning(() =>
          repository.getCalendarWorkspace(),
        );
        if (active && version === request) {
          setWorkspace(next);
          setNow(new Date());
        }
      } catch (cause) {
        if (active && version === request) {
          setWorkspace(null);
          setError(getErrorMessage(cause));
        }
      } finally {
        if (active && version === request) setLoading(false);
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    window.addEventListener(MYPLAN_DATA_CHANGED, load);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      active = false;
      request++;
      window.clearInterval(timer);
      window.removeEventListener(MYPLAN_DATA_CHANGED, load);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [repository, revision]);
  return { workspace, loading, error, now, refresh };
}
