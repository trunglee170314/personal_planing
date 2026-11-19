-- Moving an occurrence changes its schedule, not its current outcome. Read
-- outcomes under the account/entry lock instead of accepting stale UI copies.
begin;
create or replace function public.myplan_move_occurrences(target_entry uuid,changes jsonb)
returns void language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare
  entry_row public.calendar_entries;
  state_row public.calendar_occurrence_states;
  row_value jsonb;
  original_start timestamptz;
  move_changes jsonb;
begin
  if auth.uid() is null or not public.myplan_is_approved() then
    raise exception 'Approved account required.';
  end if;
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes)>1000 then
    raise exception 'Invalid occurrence moves.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('myplan-undo:'||auth.uid()::text,0));
  select * into entry_row from public.calendar_entries
    where id=target_entry and owner_user_id=auth.uid() for update;
  if not found then raise exception 'Calendar item not found.';end if;
  for row_value in select value from jsonb_array_elements(changes) loop
    original_start:=(row_value->>'occurrence_start')::timestamptz;
    select * into state_row from public.calendar_occurrence_states
      where calendar_entry_id=target_entry and owner_user_id=auth.uid()
        and occurrence_start=original_start for update;
    move_changes:=row_value-'occurrence_start'-'completed_at'-'not_needed_at';
    if found then
      -- Explicit NULL outcomes on an existing state override legacy base values.
      move_changes:=move_changes||jsonb_build_object(
        'completed_at',state_row.completed_at,'not_needed_at',state_row.not_needed_at);
    else
      move_changes:=move_changes||jsonb_build_object(
        'completed_at',entry_row.completed_at,'not_needed_at',entry_row.not_needed_at);
    end if;
    perform public.myplan_update_occurrence(target_entry,original_start,move_changes);
  end loop;
end $$;
revoke all on function public.myplan_move_occurrences(uuid,jsonb) from public,anon;
grant execute on function public.myplan_move_occurrences(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
