-- A repeating Checklist must be finite so Task progress has a stable total.

do $$ begin
  if exists (
    select 1
    from public.recurrence_rules rule
    join public.calendar_entries entry on entry.id=rule.calendar_entry_id
    where entry.item_type='checklist' and rule.rrule not like '%UNTIL=%'
  ) then
    raise exception 'Set a repeat-until date on existing repeating Checklists before applying 0012.';
  end if;
end $$;

create or replace function public.validate_checklist_recurrence_horizon()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_item_type text;
begin
  select item_type into target_item_type
  from public.calendar_entries
  where id=new.calendar_entry_id and owner_user_id=new.owner_user_id;
  if target_item_type='checklist' and new.rrule not like '%UNTIL=%' then
    raise exception 'A repeating Checklist requires a repeat-until date.';
  end if;
  return new;
end;
$$;

drop trigger if exists recurrence_rules_validate_checklist_horizon
  on public.recurrence_rules;
create trigger recurrence_rules_validate_checklist_horizon
before insert or update of rrule,calendar_entry_id
on public.recurrence_rules for each row
execute function public.validate_checklist_recurrence_horizon();
