-- Allow an explicit Task completion while keeping checklist history honest.
-- Every unresolved occurrence in a finite repeating checklist is marked with
-- the Task completion timestamp. Reopening restores only those exact skips.

create or replace function public.myplan_month_occurrence(
  base_start timestamptz,
  months_to_add integer
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  with local_value as (
    select base_start at time zone 'Asia/Ho_Chi_Minh' as value
  ), target_month as (
    select value,
      date_trunc('month',value) + make_interval(months => months_to_add) as first_day
    from local_value
  )
  select (
    make_date(
      extract(year from first_day)::integer,
      extract(month from first_day)::integer,
      least(
        extract(day from value)::integer,
        extract(day from (first_day + interval '1 month' - interval '1 day'))::integer
      )
    )::timestamp + value::time
  ) at time zone 'Asia/Ho_Chi_Minh'
  from target_month;
$$;

revoke all on function public.myplan_month_occurrence(timestamptz,integer) from public;
grant execute on function public.myplan_month_occurrence(timestamptz,integer)
  to authenticated,service_role;

create or replace function public.set_myplan_task_completion(
  target_task_id uuid,
  should_complete boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  task_row public.tasks%rowtype;
  changed_at timestamptz := now();
  next_status text;
  checklist_total integer := 0;
  checklist_resolved integer := 0;
begin
  select * into task_row from public.tasks
  where id=target_task_id and user_id=auth.uid() for update;
  if not found then raise exception 'Task not found.'; end if;
  if (task_row.completed_at is not null)=should_complete then return; end if;

  if should_complete then
    update public.calendar_entries
    set not_needed_at=changed_at,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and completed_at is null
      and not_needed_at is null;

    with specs as (
      select e.id,e.owner_user_id,e.starts_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly' else 'daily' end as frequency,
        to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
          'YYYYMMDD"T"HH24MISS"Z"') as until_at
      from public.calendar_entries e join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          else public.myplan_month_occurrence(s.starts_at,n*s.step)
        end as occurrence_start
      from specs s cross join lateral generate_series(0,999) n
    )
    insert into public.calendar_occurrence_states
      (owner_user_id,calendar_entry_id,occurrence_start,completed_at,not_needed_at,updated_at)
    select owner_user_id,id,occurrence_start,null,changed_at,changed_at
    from occurrences where occurrence_start<=until_at
    on conflict (owner_user_id,calendar_entry_id,occurrence_start) do update
      set not_needed_at=excluded.not_needed_at,updated_at=excluded.updated_at
      where public.calendar_occurrence_states.completed_at is null
        and public.calendar_occurrence_states.not_needed_at is null;

    update public.tasks set
      previous_status=case when status='completed' then previous_status else status end,
      status='completed',completed_at=changed_at,progress=100,updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  else
    update public.calendar_entries set not_needed_at=null,updated_at=changed_at
    where task_id=target_task_id and owner_user_id=auth.uid()
      and item_type='checklist' and not_needed_at=task_row.completed_at;

    update public.calendar_occurrence_states state
    set not_needed_at=null,updated_at=changed_at
    where state.owner_user_id=auth.uid() and state.not_needed_at=task_row.completed_at
      and exists (select 1 from public.calendar_entries entry
        where entry.id=state.calendar_entry_id and entry.task_id=target_task_id
          and entry.item_type='checklist');

    with specs as (
      select e.id,e.starts_at,e.completed_at,e.not_needed_at,r.rrule,
        coalesce((regexp_match(r.rrule,'INTERVAL=([0-9]+)'))[1]::integer,1) as step,
        case when r.rrule like '%FREQ=MONTHLY%' then 'monthly'
          when r.rrule like '%FREQ=WEEKLY%' then 'weekly'
          when r.rrule is not null then 'daily' else 'none' end as frequency,
        case when r.rrule is not null then
          to_timestamp((regexp_match(r.rrule,'UNTIL=([0-9]{8}T[0-9]{6}Z)'))[1],
            'YYYYMMDD"T"HH24MISS"Z"') end as until_at
      from public.calendar_entries e left join public.recurrence_rules r on r.calendar_entry_id=e.id
      where e.task_id=target_task_id and e.owner_user_id=auth.uid()
        and e.item_type='checklist'
    ), occurrences as (
      select s.*,
        case s.frequency
          when 'daily' then s.starts_at + make_interval(days => n*s.step)
          when 'weekly' then s.starts_at + make_interval(days => n*s.step*7)
          when 'monthly' then public.myplan_month_occurrence(s.starts_at,n*s.step)
          else s.starts_at
        end as occurrence_start
      from specs s cross join lateral
        generate_series(0,case when s.frequency='none' then 0 else 999 end) n
    ), outcomes as (
      select coalesce(state.completed_at,o.completed_at) as completed_at,
        coalesce(state.not_needed_at,o.not_needed_at) as not_needed_at
      from occurrences o left join public.calendar_occurrence_states state
        on state.calendar_entry_id=o.id and state.occurrence_start=o.occurrence_start
      where o.frequency='none' or o.occurrence_start<=o.until_at
    )
    select count(*),count(*) filter (
      where completed_at is not null or not_needed_at is not null
    ) into checklist_total,checklist_resolved from outcomes;

    next_status := coalesce(task_row.previous_status,'planned');
    update public.tasks set
      status=case when checklist_total>0 and checklist_resolved=checklist_total
        then 'completed' else next_status end,
      previous_status=case when checklist_total>0 and checklist_resolved=checklist_total
        then next_status else null end,
      completed_at=case when checklist_total>0 and checklist_resolved=checklist_total
        then changed_at else null end,
      progress=case when checklist_total=0 then 0
        else round(checklist_resolved*100.0/checklist_total)::integer end,
      updated_at=changed_at
    where id=target_task_id and user_id=auth.uid();
  end if;
end;
$$;

revoke all on function public.set_myplan_task_completion(uuid,boolean) from public;
grant execute on function public.set_myplan_task_completion(uuid,boolean) to authenticated;
