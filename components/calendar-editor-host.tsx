'use client';
import { useEffect, useState } from 'react';
import { CalendarItemsManager } from '@/app/calendar-items-manager';
export type CalendarEditorRequest = {
  type: 'checklist' | 'reminder';
  id?: string;
  taskId?: string;
};
const EVENT = 'myplan-open-calendar-editor';
export function openCalendarEditor(request: CalendarEditorRequest) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: request }));
}
export function CalendarEditorHost() {
  const [request, setRequest] = useState<
    (CalendarEditorRequest & { key: number }) | null
  >(null);
  useEffect(() => {
    const listener = (event: Event) =>
      setRequest({
        ...(event as CustomEvent<CalendarEditorRequest>).detail,
        key: Date.now(),
      });
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  return request ? (
    <CalendarItemsManager
      key={request.key}
      type={request.type}
      editorOnly
      openId={request.id}
      createTaskId={request.taskId}
    />
  ) : null;
}
