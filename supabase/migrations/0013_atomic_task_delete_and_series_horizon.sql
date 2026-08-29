-- Keep whole-series horizons stable when moving across dates, and make a
-- permanent Task delete one account-scoped transaction.

create or replace function public.move_calendar_series(
  target_entry_id uuid,
  original_occurrence_start timestamptz,
  original_occurrence_end timestamptz,
  next_occurrence_start timestamptz,
  next_occurrence_end timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  entry_row public.calendar_entries%rowtype;
  delta_start interval;
  delta_end interval;
  delta_days integer;
begin
  select * into entry_row from public.calendar_entries
  where id=target_entry_id and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.'; end if;
  if next_occurrence_end <= next_occurrence_start then
    raise exception 'Series end must be after its start.';
  end if;
  if entry_row.item_type='reminder' then
    next_occurrence_end := next_occurrence_start + interval '15 minutes';
  end if;
  delta_start := next_occurrence_start-original_occurrence_start;
  delta_end := next_occurrence_end-original_occurrence_end;
  delta_days :=
    (next_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date -
    (original_occurrence_start at time zone 'Asia/Ho_Chi_Minh')::date;

  update public.calendar_entries
  set starts_at=starts_at+delta_start,ends_at=ends_at+delta_end
  where id=target_entry_id and owner_user_id=auth.uid();

  if delta_days <> 0 then
    update public.recurrence_rules
    set rrule=regexp_replace(
      rrule,
      'UNTIL=[0-9]{8}T235959Z',
      'UNTIL=' || to_char(
        to_date(substring(rrule from 'UNTIL=([0-9]{8})'),'YYYYMMDD') + delta_days,
        'YYYYMMDD'
      ) || 'T235959Z'
    )
    where calendar_entry_id=target_entry_id
      and owner_user_id=auth.uid()
      and rrule like '%UNTIL=%';
  end if;

  update public.calendar_occurrence_states
  set occurrence_start=occurrence_start+interval '400 years'
  where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
  update public.calendar_occurrence_states
  set occurrence_start=occurrence_start-interval '400 years'+delta_start,
      override_starts_at=case when override_starts_at is null then null else override_starts_at+delta_start end,
      override_ends_at=case when override_ends_at is null then null else override_ends_at+delta_end end
  where calendar_entry_id=target_entry_id and owner_user_id=auth.uid();
end;
$$;

create or replace function public.delete_myplan_task(target_task_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.tasks
    where id=target_task_id and user_id=auth.uid()
    for update
  ) then
    raise exception 'Task not found.';
  end if;

  update public.tasks set parent_task_id=null
    where parent_task_id=target_task_id and user_id=auth.uid();
  update public.tasks set dependency_task_id=null
    where dependency_task_id=target_task_id and user_id=auth.uid();
  update public.calendar_entries
    set task_id=null,item_type='reminder',ends_at=starts_at+interval '15 minutes'
    where task_id=target_task_id and owner_user_id=auth.uid();
  delete from public.tasks
    where id=target_task_id and user_id=auth.uid();
end;
$$;

revoke all on function public.delete_myplan_task(uuid) from public;
grant execute on function public.delete_myplan_task(uuid) to authenticated;
