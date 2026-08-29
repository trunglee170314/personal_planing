-- Keep Reminders point-in-time and independent from Tasks. The application
-- stores an internal 15-minute end only so the shared calendar range model can
-- render and index them consistently.

update public.calendar_entries
set item_type = 'reminder',
    ends_at = starts_at + interval '15 minutes',
    updated_at = now()
where item_type = 'checklist' and task_id is null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_entries_reminder_shape_check'
  ) then
    alter table public.calendar_entries
      add constraint calendar_entries_reminder_shape_check
      check (
        item_type <> 'reminder' or
        (task_id is null and ends_at = starts_at + interval '15 minutes')
      ) not valid;
  end if;
end $$;

alter table public.calendar_entries
  validate constraint calendar_entries_checklist_task_check;
alter table public.calendar_entries
  validate constraint calendar_entries_reminder_shape_check;
