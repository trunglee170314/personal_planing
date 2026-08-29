'use client';

import { useMemo, useRef, useState } from 'react';
import {
  addDays,
  CALENDAR_END_HOUR,
  CALENDAR_SNAP_MINUTES,
  CALENDAR_START_HOUR,
  dateKey,
  expandRecurringSessions,
  minutesFromCalendarStart,
  snapDate,
} from '@/lib/calendar';
import type { CalendarSession } from '@/lib/data/repository';

const HOUR_HEIGHT = 64;
const TOTAL_MINUTES = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60;
type DragState = {
  session: CalendarSession;
  startX: number;
  startY: number;
  resize: boolean;
};

export function CalendarWeekGrid({
  weekStart,
  sessions,
  compact = false,
  selectedDay = new Date(),
  dayCount = 7,
  onSelectDay,
  onCreate,
  onEdit,
  onMove,
}: {
  weekStart: Date;
  sessions: CalendarSession[];
  compact?: boolean;
  selectedDay?: Date;
  dayCount?: 1 | 7;
  onSelectDay?: (day: Date) => void;
  onCreate?: (start: Date, end: Date) => void;
  onEdit?: (session: CalendarSession) => void;
  onMove?: (session: CalendarSession, start: Date, end: Date) => void;
}) {
  const days = useMemo(
    () =>
      Array.from({ length: dayCount }, (_, index) => addDays(weekStart, index)),
    [dayCount, weekStart],
  );
  const rangeEnd = useMemo(
    () => addDays(weekStart, dayCount),
    [dayCount, weekStart],
  );
  const occurrences = useMemo(
    () => expandRecurringSessions(sessions, weekStart, rangeEnd),
    [sessions, weekStart, rangeEnd],
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const createDrag = useRef<{ startY: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const hours = Array.from(
    { length: CALENDAR_END_HOUR - CALENDAR_START_HOUR },
    (_, index) => index + CALENDAR_START_HOUR,
  );
  const selectedKey = dateKey(selectedDay);

  function finishCreate(event: React.PointerEvent<HTMLElement>, day: Date) {
    if (!onCreate || !createDrag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const firstY = Math.min(createDrag.current.startY, event.clientY);
    const lastY = Math.max(createDrag.current.startY, event.clientY);
    const startMinute = Math.max(
      0,
      Math.min(
        TOTAL_MINUTES - 30,
        Math.round(
          (((firstY - rect.top) / HOUR_HEIGHT) * 60) / CALENDAR_SNAP_MINUTES,
        ) * CALENDAR_SNAP_MINUTES,
      ),
    );
    const draggedMinutes =
      Math.round(
        (((lastY - firstY) / HOUR_HEIGHT) * 60) / CALENDAR_SNAP_MINUTES,
      ) * CALENDAR_SNAP_MINUTES;
    const start = new Date(day);
    start.setHours(CALENDAR_START_HOUR, startMinute, 0, 0);
    onCreate(
      start,
      new Date(start.getTime() + Math.max(60, draggedMinutes) * 60_000),
    );
    createDrag.current = null;
  }

  function finishDrag(event: React.PointerEvent) {
    if (!drag || !onMove) return;
    const dayDelta = Math.round(
      (event.clientX - drag.startX) /
        Math.max(1, (gridRef.current?.clientWidth ?? 700) / dayCount),
    );
    const minuteDelta =
      Math.round(
        (((event.clientY - drag.startY) / HOUR_HEIGHT) * 60) /
          CALENDAR_SNAP_MINUTES,
      ) * CALENDAR_SNAP_MINUTES;
    const start = new Date(drag.session.starts_at);
    const end = new Date(drag.session.ends_at);
    if (drag.resize) end.setMinutes(end.getMinutes() + minuteDelta);
    else {
      start.setDate(start.getDate() + dayDelta);
      end.setDate(end.getDate() + dayDelta);
      start.setMinutes(start.getMinutes() + minuteDelta);
      end.setMinutes(end.getMinutes() + minuteDelta);
    }
    if (end.getTime() - start.getTime() >= CALENDAR_SNAP_MINUTES * 60_000)
      onMove(drag.session, snapDate(start), snapDate(end));
    setDrag(null);
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      {dayCount === 7 ? (
        <div className="grid grid-cols-7 border-b bg-muted/30 md:hidden">
          {days.map((day) => (
            <button
              key={`strip-${dateKey(day)}`}
              type="button"
              onClick={() => onSelectDay?.(day)}
              className="px-1 py-2 text-center"
            >
              <span className="block text-[9px] uppercase text-muted-foreground">
                {day.toLocaleDateString(undefined, { weekday: 'narrow' })}
              </span>
              <span
                className={`mx-auto mt-1 grid size-7 place-items-center rounded-full text-xs ${dateKey(day) === selectedKey ? 'bg-primary text-primary-foreground' : ''}`}
              >
                {day.getDate()}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={`grid border-b bg-muted/30 ${dayCount === 1 ? 'grid-cols-[52px_minmax(240px,1fr)]' : 'grid-cols-[52px_repeat(7,minmax(100px,1fr))] max-md:hidden'}`}
      >
        <div />
        {days.map((day) => (
          <button
            key={dateKey(day)}
            type="button"
            onClick={() => onSelectDay?.(day)}
            className={`border-l px-2 py-3 text-center ${dateKey(day) === selectedKey ? 'max-md:block' : 'max-md:hidden'}`}
          >
            <span className="block text-[10px] font-bold uppercase text-muted-foreground">
              {day.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <span
              className={`mx-auto mt-1 grid size-8 place-items-center rounded-full text-sm font-semibold ${dateKey(day) === dateKey(new Date()) ? 'bg-primary text-primary-foreground' : ''}`}
            >
              {day.getDate()}
            </span>
          </button>
        ))}
      </div>
      {occurrences.some((session) => session.all_day) ? (
        <div
          className={`grid border-b ${dayCount === 1 ? 'grid-cols-[52px_minmax(240px,1fr)]' : 'grid-cols-[52px_repeat(7,minmax(100px,1fr))] max-md:grid-cols-[48px_minmax(240px,1fr)]'}`}
        >
          <span className="p-2 text-[9px] text-muted-foreground">All day</span>
          {days.map((day) => (
            <div
              key={`all-${dateKey(day)}`}
              className={`${dateKey(day) === selectedKey ? 'max-md:block' : 'max-md:hidden'} border-l p-1`}
            >
              {occurrences
                .filter(
                  (session) =>
                    session.all_day &&
                    dateKey(new Date(session.starts_at)) === dateKey(day),
                )
                .map((session) => (
                  <button
                    data-session
                    type="button"
                    key={session.occurrence_id}
                    onClick={() => onEdit?.(session)}
                    className="block w-full truncate rounded bg-primary px-2 py-1 text-left text-[10px] text-primary-foreground"
                  >
                    {session.title}
                  </button>
                ))}
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={`overflow-auto ${compact ? 'max-h-[600px]' : 'max-h-[68vh]'}`}
      >
        <div
          ref={gridRef}
          className={`relative grid ${dayCount === 1 ? 'min-w-0 grid-cols-[52px_minmax(240px,1fr)]' : 'min-w-[760px] grid-cols-[52px_repeat(7,minmax(100px,1fr))] max-md:min-w-0 max-md:grid-cols-[48px_minmax(240px,1fr)]'}`}
          style={{ height: (TOTAL_MINUTES / 60) * HOUR_HEIGHT }}
          onPointerUp={finishDrag}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="relative">
            {hours.map((hour) => (
              <span
                key={hour}
                className="absolute right-2 -translate-y-2 text-[10px] text-muted-foreground"
                style={{ top: (hour - CALENDAR_START_HOUR) * HOUR_HEIGHT }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((day) => {
            const visibleStart = new Date(day);
            visibleStart.setHours(CALENDAR_START_HOUR, 0, 0, 0);
            const visibleEnd = addDays(
              new Date(day.getFullYear(), day.getMonth(), day.getDate()),
              1,
            );
            const daySessions = occurrences.filter(
              (session) =>
                new Date(session.starts_at) < visibleEnd &&
                new Date(session.ends_at) > visibleStart &&
                !session.all_day,
            );
            return (
              <div
                key={dateKey(day)}
                className={`relative border-l bg-[linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[length:100%_64px] ${dateKey(day) === selectedKey ? 'max-md:block' : 'max-md:hidden'}`}
              >
                <button
                  type="button"
                  aria-label={`Create session on ${day.toLocaleDateString()}`}
                  className="absolute inset-0"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    createDrag.current = { startY: event.clientY };
                  }}
                  onPointerUp={(event) => finishCreate(event, day)}
                />
                {daySessions.map((session) => {
                  const originalStart = new Date(session.starts_at);
                  const originalEnd = new Date(session.ends_at);
                  const start =
                    originalStart < visibleStart ? visibleStart : originalStart;
                  const end =
                    originalEnd > visibleEnd ? visibleEnd : originalEnd;
                  const top = Math.max(
                    0,
                    (minutesFromCalendarStart(start) / 60) * HOUR_HEIGHT,
                  );
                  const height = Math.max(
                    24,
                    ((end.getTime() - start.getTime()) / 3_600_000) *
                      HOUR_HEIGHT,
                  );
                  const overlaps = daySessions.filter(
                    (item) =>
                      new Date(item.starts_at) < end &&
                      new Date(item.ends_at) > start,
                  );
                  const overlapIndex = Math.max(
                    0,
                    overlaps.findIndex(
                      (item) => item.occurrence_id === session.occurrence_id,
                    ),
                  );
                  const width = 100 / Math.max(1, overlaps.length);
                  return (
                    <button
                      data-session
                      key={session.occurrence_id}
                      type="button"
                      className="absolute z-10 overflow-hidden rounded-lg border border-primary/20 bg-primary px-2 py-1 text-left text-[10px] leading-tight text-primary-foreground shadow-sm touch-none"
                      style={{
                        top,
                        height,
                        left: `${overlapIndex * width}%`,
                        width: `calc(${width}% - 2px)`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit?.(session);
                      }}
                      onPointerDown={(event) => {
                        if (!onMove || session.recurrence !== 'none') return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag({
                          session,
                          startX: event.clientX,
                          startY: event.clientY,
                          resize: false,
                        });
                      }}
                    >
                      <strong className="block truncate">
                        {session.title}
                      </strong>
                      <span>
                        {originalStart.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        –
                        {originalEnd.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {onMove && session.recurrence === 'none' ? (
                        <span
                          aria-label="Resize"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            setDrag({
                              session,
                              startX: event.clientX,
                              startY: event.clientY,
                              resize: true,
                            });
                          }}
                          className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize bg-black/10"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {new Date() >= weekStart && new Date() < rangeEnd ? (
            <span
              className="pointer-events-none absolute z-20 h-px bg-destructive max-md:hidden"
              style={{
                left:
                  dayCount === 1
                    ? '52px'
                    : `calc(52px + ${new Date().getDay() === 0 ? 6 : new Date().getDay() - 1} * ((100% - 52px) / 7))`,
                width:
                  dayCount === 1
                    ? 'calc(100% - 52px)'
                    : 'calc((100% - 52px) / 7)',
                top: (minutesFromCalendarStart(new Date()) / 60) * HOUR_HEIGHT,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
