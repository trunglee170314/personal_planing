-- Lossless per-occurrence overrides and an atomic whole-series move/resize.

alter table public.calendar_occurrence_states
  add column if not exists override_starts_at timestamptz,
  add column if not exists override_ends_at timestamptz;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_occurrence_states_override_range_check'
  ) then
    alter table public.calendar_occurrence_states
      add constraint calendar_occurrence_states_override_range_check
      check (
        (override_starts_at is null and override_ends_at is null) or
        (override_starts_at is not null and override_ends_at > override_starts_at)
      );
  end if;
end $$;

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
begin
  select * into entry_row
  from public.calendar_entries
  where id = target_entry_id and owner_user_id = auth.uid()
  for update;

  if not found then
    raise exception 'Calendar item not found.';
  end if;
  if next_occurrence_end <= next_occurrence_start then
    raise exception 'Series end must be after its start.';
  end if;
  if entry_row.item_type = 'reminder' then
    next_occurrence_end := next_occurrence_start + interval '15 minutes';
  end if;

  delta_start := next_occurrence_start - original_occurrence_start;
  delta_end := next_occurrence_end - original_occurrence_end;

  update public.calendar_entries
  set starts_at = starts_at + delta_start,
      ends_at = ends_at + delta_end
  where id = target_entry_id and owner_user_id = auth.uid();

  update public.calendar_occurrence_states
  set occurrence_start = occurrence_start + interval '400 years'
  where calendar_entry_id = target_entry_id and owner_user_id = auth.uid();

  update public.calendar_occurrence_states
  set occurrence_start = occurrence_start - interval '400 years' + delta_start,
      override_starts_at = case when override_starts_at is null then null
        else override_starts_at + delta_start end,
      override_ends_at = case when override_ends_at is null then null
        else override_ends_at + delta_end end
  where calendar_entry_id = target_entry_id and owner_user_id = auth.uid();
end;
$$;

revoke all on function public.move_calendar_series(
  uuid,timestamptz,timestamptz,timestamptz,timestamptz
) from public;
grant execute on function public.move_calendar_series(
  uuid,timestamptz,timestamptz,timestamptz,timestamptz
) to authenticated;
