'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  addDays,
  CALENDAR_END_HOUR,
  CALENDAR_SNAP_MINUTES,
  CALENDAR_START_HOUR,
  dateKey,
  expandRecurringSessions,
  minutesFromCalendarStart,
  snapDate,
  vietnamDateKey,
  vietnamInputToIso,
} from '@/lib/calendar';
import { layoutCalendarLanes } from '@/lib/calendar-layout';
import {
  guardPlanningPointer,
  ownsPlanningPointer,
} from '@/lib/pointer-actions';
import type { CalendarSession } from '@/lib/data/repository';
import type { CalendarOccurrenceState } from '@/lib/data/repository';

type CalendarOccurrence = CalendarSession & {
  occurrence_id: string;
  occurrence_start: string;
};

const HOUR_HEIGHT = 72;
const HEADER_HEIGHT = 76;
const TOTAL_MINUTES = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 60;

type Preview = { id: string; start: Date; end: Date };
type Drag = {
  session: CalendarOccurrence;
  startX: number;
  startY: number;
  pointerId: number;
  mode: 'move' | 'resize-start' | 'resize-end';
  activated: boolean;
};

export function CalendarGridV2({
  anchor,
  dayCount,
  sessions,
  occurrenceStates,
  height,
  colorFor,
  detailsFor,
  onCreate,
  onEdit,
  onMove,
  onToggle,
  onHeightChange,
}: {
  anchor: Date;
  dayCount: 1 | 7;
  sessions: CalendarSession[];
  occurrenceStates: CalendarOccurrenceState[];
  height: number;
  colorFor: (session: CalendarSession) => string;
  detailsFor?: (session: CalendarSession) => string;
  onCreate: (start: Date, end: Date) => void;
  onEdit: (session: CalendarOccurrence) => void;
  onMove: (session: CalendarOccurrence, start: Date, end: Date) => void;
  onToggle: (session: CalendarOccurrence) => void;
  onHeightChange: (height: number) => void;
}) {
  const start = useMemo(
    () => (dayCount === 7 ? startMonday(anchor) : startDay(anchor)),
    [anchor, dayCount],
  );
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, index) => addDays(start, index)),
    [dayCount, start],
  );
  const end = useMemo(() => addDays(start, dayCount), [dayCount, start]);
  const rangeStart = useMemo(
    () => new Date(vietnamInputToIso(`${dateKey(start)}T00:00`)),
    [start],
  );
  const rangeEnd = useMemo(
    () => new Date(vietnamInputToIso(`${dateKey(end)}T00:00`)),
    [end],
  );
  const occurrences = useMemo(
    () =>
      expandRecurringSessions(sessions, rangeStart, rangeEnd, occurrenceStates),
    [occurrenceStates, rangeEnd, rangeStart, sessions],
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef<{ key: string; hadItems: boolean } | null>(null);
  const createRef = useRef<{ y: number; day: Date; pointerId: number } | null>(
    null,
  );
  const dragRef = useRef<Drag | null>(null);
  const heightRef = useRef<{
    y: number;
    height: number;
    pointerId: number;
  } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const queuedPreviewRef = useRef<
    | { kind: 'drag'; value: Preview }
    | { kind: 'create'; value: { day: Date; start: Date; end: Date } }
    | null
  >(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [createPreview, setCreatePreview] = useState<{
    day: Date;
    start: Date;
    end: Date;
  } | null>(null);
  const hours = Array.from(
    { length: CALENDAR_END_HOUR - CALENDAR_START_HOUR },
    (_, index) => index + CALENDAR_START_HOUR,
  );
  // The header and time grid must share both their scroll viewport and tracks.
  // Separate viewports drift by the scrollbar width (and when scrolled sideways).
  const columnClass =
    dayCount === 1
      ? 'min-w-0 grid-cols-[56px_1fr]'
      : 'min-w-[760px] grid-cols-[56px_repeat(7,minmax(96px,1fr))]';
  // Keep overlap lanes actionable. Dense weeks can scroll horizontally instead
  // of reducing every checklist to just its checkbox and notification icon.
  const minCalendarWidth = useMemo(() => {
    let lanes = 1;
    for (const day of days) {
      const dayStart = new Date(`${dateKey(day)}T00:00:00+07:00`).getTime(),
        dayEnd = dayStart + 86400000;
      const items = occurrences.filter(
        (item) =>
          new Date(item.starts_at).getTime() < dayEnd &&
          new Date(item.ends_at).getTime() > dayStart,
      );
      const layout = layoutCalendarLanes(
        items.map((item) => ({
          id: item.occurrence_id,
          start: new Date(item.starts_at).getTime(),
          end: new Date(item.ends_at).getTime(),
        })),
      );
      for (const slot of layout.values())
        lanes = Math.max(lanes, slot.laneCount);
    }
    return 56 + dayCount * Math.max(dayCount === 1 ? 240 : 120, lanes * 112);
  }, [dayCount, days, occurrences]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null)
        window.cancelAnimationFrame(animationFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const selectedKey = dateKey(anchor);
    const visible = occurrences
      .filter((item) => vietnamDateKey(item.starts_at) === selectedKey)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const scrollKey = `${selectedKey}:${dayCount}`;
    if (
      autoScrollRef.current?.key === scrollKey &&
      (autoScrollRef.current.hadItems || visible.length === 0)
    )
      return;
    const isToday = selectedKey === vietnamDateKey(new Date());
    const targetMinutes = visible.length
      ? Math.max(
          0,
          minutesFromCalendarStart(new Date(visible[0].starts_at)) - 45,
        )
      : isToday
        ? Math.max(0, minutesFromCalendarStart(new Date()) - 90)
        : 7 * 60;
    scroll.scrollTop = (targetMinutes / 60) * HOUR_HEIGHT;
    autoScrollRef.current = { key: scrollKey, hadItems: visible.length > 0 };
  }, [anchor, dayCount, occurrences]);

  function queuePreview(
    value:
      | { kind: 'drag'; value: Preview }
      | { kind: 'create'; value: { day: Date; start: Date; end: Date } },
  ) {
    queuedPreviewRef.current = value;
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      const queued = queuedPreviewRef.current;
      if (queued?.kind === 'drag') setPreview(queued.value);
      if (queued?.kind === 'create') setCreatePreview(queued.value);
      queuedPreviewRef.current = null;
      animationFrameRef.current = null;
    });
  }

  function clearQueuedPreviews() {
    queuedPreviewRef.current = null;
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function rangeFromPointer(day: Date, y1: number, y2: number, rect: DOMRect) {
    const low = Math.min(y1, y2);
    const high = Math.max(y1, y2);
    const minute = Math.max(
      0,
      Math.min(
        TOTAL_MINUTES - 15,
        Math.round((((low - rect.top) / HOUR_HEIGHT) * 60) / 15) * 15,
      ),
    );
    const duration = Math.max(
      30,
      Math.round((((high - low) / HOUR_HEIGHT) * 60) / 15) * 15,
    );
    const totalMinutes = CALENDAR_START_HOUR * 60 + minute;
    const hour = Math.floor(totalMinutes / 60);
    const minutePart = totalMinutes % 60;
    const rangeStart = new Date(
      vietnamInputToIso(
        `${dateKey(day)}T${String(hour).padStart(2, '0')}:${String(minutePart).padStart(2, '0')}`,
      ),
    );
    return {
      start: rangeStart,
      end: new Date(rangeStart.getTime() + duration * 60_000),
    };
  }

  function dragDates(state: Drag, clientX: number, clientY: number) {
    const columnWidth = Math.max(
      1,
      (gridRef.current?.clientWidth ?? 700) / dayCount,
    );
    const dayDelta =
      state.mode === 'move'
        ? Math.round((clientX - state.startX) / columnWidth)
        : 0;
    const minuteDelta =
      Math.round(
        (((clientY - state.startY) / HOUR_HEIGHT) * 60) / CALENDAR_SNAP_MINUTES,
      ) * CALENDAR_SNAP_MINUTES;
    const nextStart = new Date(state.session.starts_at);
    const nextEnd = new Date(state.session.ends_at);
    if (state.mode === 'move') {
      nextStart.setTime(
        nextStart.getTime() + dayDelta * 86_400_000 + minuteDelta * 60_000,
      );
      nextEnd.setTime(
        nextEnd.getTime() + dayDelta * 86_400_000 + minuteDelta * 60_000,
      );
    } else if (state.mode === 'resize-start') {
      nextStart.setTime(nextStart.getTime() + minuteDelta * 60_000);
    } else {
      nextEnd.setTime(nextEnd.getTime() + minuteDelta * 60_000);
    }
    if (nextEnd.getTime() - nextStart.getTime() < 15 * 60_000) return null;
    return {
      id: state.session.occurrence_id,
      start: snapDate(nextStart),
      end: snapDate(nextEnd),
    };
  }

  function pointerMove(event: React.PointerEvent) {
    if (
      !ownsPlanningPointer(
        event,
        heightRef.current ?? createRef.current ?? dragRef.current,
      )
    )
      return;
    if (heightRef.current) {
      onHeightChange(
        Math.max(
          360,
          Math.min(
            Math.max(900, window.innerHeight * 2),
            heightRef.current.height + event.clientY - heightRef.current.y,
          ),
        ),
      );
      return;
    }
    if (createRef.current) {
      const column = event.currentTarget.querySelector(
        `[data-day="${dateKey(createRef.current.day)}"]`,
      ) as HTMLElement | null;
      if (column) {
        const range = rangeFromPointer(
          createRef.current.day,
          createRef.current.y,
          event.clientY,
          column.getBoundingClientRect(),
        );
        queuePreview({
          kind: 'create',
          value: { day: createRef.current.day, ...range },
        });
      }
      return;
    }
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId)
      return;
    const state = dragRef.current;
    if (!state.activated) {
      const distance = Math.hypot(
        event.clientX - state.startX,
        event.clientY - state.startY,
      );
      if (distance < 4) return;
      state.activated = true;
    }
    const next = dragDates(dragRef.current, event.clientX, event.clientY);
    if (next) queuePreview({ kind: 'drag', value: next });
  }

  function pointerUp(event: React.PointerEvent) {
    if (
      !ownsPlanningPointer(
        event,
        heightRef.current ?? createRef.current ?? dragRef.current,
      )
    )
      return;
    clearQueuedPreviews();
    if (heightRef.current) {
      heightRef.current = null;
      return;
    }
    if (createRef.current) {
      const column = event.currentTarget.querySelector(
        `[data-day="${dateKey(createRef.current.day)}"]`,
      ) as HTMLElement | null;
      if (column) {
        const range = rangeFromPointer(
          createRef.current.day,
          createRef.current.y,
          event.clientY,
          column.getBoundingClientRect(),
        );
        onCreate(range.start, range.end);
      }
    }
    createRef.current = null;
    setCreatePreview(null);
    if (dragRef.current && event.pointerId === dragRef.current.pointerId) {
      const state = dragRef.current;
      const finalPreview = dragDates(state, event.clientX, event.clientY);
      if (state.activated && finalPreview)
        onMove(state.session, finalPreview.start, finalPreview.end);
      else if (state.mode === 'move') onEdit(state.session);
    }
    dragRef.current = null;
    setPreview(null);
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl border bg-card shadow-sm"
      onPointerDownCapture={guardPlanningPointer}
    >
      <div
        ref={scrollRef}
        className="isolate overflow-auto"
        style={{ height: height + HEADER_HEIGHT }}
      >
        <div
          className={`sticky top-0 z-30 grid border-b bg-card ${columnClass}`}
          style={{ height: HEADER_HEIGHT, minWidth: minCalendarWidth }}
        >
          <div />
          {days.map((day) => (
            <div key={dateKey(day)} className="border-l px-2 py-3 text-center">
              <span className="block text-[10px] font-bold uppercase text-muted-foreground">
                {day.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span
                className={`mx-auto mt-1 grid size-8 place-items-center rounded-full text-sm font-semibold ${dateKey(day) === vietnamDateKey(new Date()) ? 'bg-primary text-primary-foreground' : ''}`}
              >
                {day.getDate()}
              </span>
            </div>
          ))}
        </div>
        <div
          ref={gridRef}
          className={`relative grid ${columnClass}`}
          style={{
            height: (TOTAL_MINUTES / 60) * HOUR_HEIGHT,
            minWidth: minCalendarWidth,
          }}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={(event) => {
            if (
              !ownsPlanningPointer(event, createRef.current ?? dragRef.current)
            )
              return;
            clearQueuedPreviews();
            dragRef.current = null;
            createRef.current = null;
            setPreview(null);
            setCreatePreview(null);
          }}
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
            const dayStart = new Date(
              vietnamInputToIso(
                `${dateKey(day)}T${String(CALENDAR_START_HOUR).padStart(2, '0')}:00`,
              ),
            );
            const dayEnd = new Date(
              vietnamInputToIso(`${dateKey(addDays(day, 1))}T00:00`),
            );
            const items = occurrences.filter((item) => {
              const shownStart =
                preview?.id === item.occurrence_id
                  ? preview.start
                  : new Date(item.starts_at);
              const shownEnd =
                preview?.id === item.occurrence_id
                  ? preview.end
                  : new Date(item.ends_at);
              return (
                !item.all_day && shownStart < dayEnd && shownEnd > dayStart
              );
            });
            const laneLayout = layoutCalendarLanes(
              items.map((item) => ({
                id: item.occurrence_id,
                start:
                  preview?.id === item.occurrence_id
                    ? preview.start.getTime()
                    : new Date(item.starts_at).getTime(),
                end:
                  preview?.id === item.occurrence_id
                    ? preview.end.getTime()
                    : new Date(item.ends_at).getTime(),
              })),
            );
            return (
              <div
                data-day={dateKey(day)}
                key={dateKey(day)}
                className="relative border-l bg-[linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[length:100%_72px]"
              >
                <button
                  type="button"
                  aria-label={`Drag to add an item on ${day.toLocaleDateString()}`}
                  className="absolute inset-0 cursor-crosshair"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    createRef.current = {
                      y: event.clientY,
                      day,
                      pointerId: event.pointerId,
                    };
                    const range = rangeFromPointer(
                      day,
                      event.clientY,
                      event.clientY,
                      event.currentTarget.getBoundingClientRect(),
                    );
                    setCreatePreview({ day, ...range });
                  }}
                />
                {items.map((item) => {
                  const shown =
                    preview?.id === item.occurrence_id
                      ? {
                          ...item,
                          starts_at: preview.start.toISOString(),
                          ends_at: preview.end.toISOString(),
                        }
                      : item;
                  const shownStart = new Date(shown.starts_at);
                  const shownEnd = new Date(shown.ends_at);
                  const visibleStart = new Date(
                    Math.max(shownStart.getTime(), dayStart.getTime()),
                  );
                  const visibleEnd = new Date(
                    Math.min(shownEnd.getTime(), dayEnd.getTime()),
                  );
                  const top = Math.max(
                    0,
                    (minutesFromCalendarStart(visibleStart) / 60) * HOUR_HEIGHT,
                  );
                  const heightPx =
                    item.item_type === 'reminder'
                      ? 30
                      : Math.max(
                          30,
                          ((visibleEnd.getTime() - visibleStart.getTime()) /
                            3_600_000) *
                            HOUR_HEIGHT,
                        );
                  const completed = Boolean(item.completed_at);
                  const inactive = completed || Boolean(item.not_needed_at);
                  const { lane, laneCount } = laneLayout.get(
                    item.occurrence_id,
                  ) ?? { lane: 0, laneCount: 1 };
                  const showsStartEdge = shownStart >= dayStart;
                  const showsEndEdge = shownEnd <= dayEnd;
                  return (
                    <div
                      key={item.occurrence_id}
                      data-item
                      title={`${item.title}\n${detailsFor?.(item) ?? ''}\n${new Date(item.starts_at).toLocaleString()} – ${new Date(item.ends_at).toLocaleTimeString()}`}
                      className={`absolute z-10 cursor-grab select-none overflow-hidden rounded-lg border px-2 py-1 text-left text-[10px] leading-tight shadow-sm touch-none active:cursor-grabbing ${inactive ? 'opacity-55' : ''}`}
                      style={{
                        top,
                        height: heightPx,
                        left: `calc(${(lane * 100) / laneCount}% + 2px)`,
                        width: `calc(${100 / laneCount}% - 4px)`,
                        color: '#fff',
                        background: colorFor(item),
                        borderColor:
                          'color-mix(in srgb, #fff 28%, transparent)',
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        dragRef.current = {
                          session: item,
                          startX: event.clientX,
                          startY: event.clientY,
                          pointerId: event.pointerId,
                          mode: 'move',
                          activated: false,
                        };
                      }}
                    >
                      <div className="flex items-start gap-1.5">
                        <Checkbox
                          checked={completed}
                          onCheckedChange={() => onToggle(item)}
                          onPointerDown={(event) => event.stopPropagation()}
                          aria-label={`${completed ? 'Reopen' : 'Complete'} ${item.title}`}
                          className="mt-0.5 border-white data-[state=checked]:bg-white data-[state=checked]:text-black"
                        />
                        <span
                          className={`pointer-events-none min-w-0 flex-1 text-left ${inactive ? 'line-through' : ''}`}
                        >
                          <strong className="block truncate">
                            {item.title}
                          </strong>
                          <span>
                            {shownStart.toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'Asia/Ho_Chi_Minh',
                            })}
                            {item.item_type === 'checklist'
                              ? `–${shownEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}`
                              : ''}
                          </span>
                        </span>
                        {item.notification_offsets.length ? (
                          <button
                            type="button"
                            aria-label={`Edit notifications for ${item.title}`}
                            className="shrink-0"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => onEdit(item)}
                          >
                            <Bell className="size-3" />
                          </button>
                        ) : null}
                      </div>
                      {item.item_type === 'checklist' ? (
                        <>
                          {showsStartEdge ? (
                            <span
                              aria-hidden
                              className="absolute inset-x-0 top-0 h-2 cursor-ns-resize"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                dragRef.current = {
                                  session: item,
                                  startX: event.clientX,
                                  startY: event.clientY,
                                  pointerId: event.pointerId,
                                  mode: 'resize-start',
                                  activated: false,
                                };
                                event.currentTarget.setPointerCapture(
                                  event.pointerId,
                                );
                              }}
                            />
                          ) : null}
                          {showsEndEdge ? (
                            <span
                              aria-hidden
                              className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize bg-black/10"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                dragRef.current = {
                                  session: item,
                                  startX: event.clientX,
                                  startY: event.clientY,
                                  pointerId: event.pointerId,
                                  mode: 'resize-end',
                                  activated: false,
                                };
                                event.currentTarget.setPointerCapture(
                                  event.pointerId,
                                );
                              }}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}
                {createPreview &&
                dateKey(createPreview.day) === dateKey(day) ? (
                  <span
                    className="pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed border-primary bg-primary/15"
                    style={{
                      top:
                        (minutesFromCalendarStart(createPreview.start) / 60) *
                        HOUR_HEIGHT,
                      height: Math.max(
                        30,
                        ((createPreview.end.getTime() -
                          createPreview.start.getTime()) /
                          3_600_000) *
                          HOUR_HEIGHT,
                      ),
                    }}
                  />
                ) : null}
              </div>
            );
          })}
          {new Date() >= rangeStart && new Date() < rangeEnd ? (
            <span
              className="pointer-events-none absolute z-20 h-px bg-destructive"
              style={{
                left:
                  dayCount === 1
                    ? 56
                    : `calc(56px + ${days.findIndex((day) => dateKey(day) === vietnamDateKey(new Date()))} * ((100% - 56px) / 7))`,
                width:
                  dayCount === 1
                    ? 'calc(100% - 56px)'
                    : 'calc((100% - 56px) / 7)',
                top: (minutesFromCalendarStart(new Date()) / 60) * HOUR_HEIGHT,
              }}
            />
          ) : null}
        </div>
      </div>
      <button
        type="button"
        aria-label="Resize calendar height"
        className="flex h-4 w-full cursor-ns-resize items-center justify-center border-t text-muted-foreground"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          heightRef.current = {
            y: event.clientY,
            height,
            pointerId: event.pointerId,
          };
        }}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={(event) => {
          if (ownsPlanningPointer(event, heightRef.current))
            heightRef.current = null;
        }}
      >
        <span className="h-1 w-12 rounded-full bg-border" />
      </button>
    </div>
  );
}

function startDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}
function startMonday(value: Date) {
  const date = startDay(value);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return date;
}
