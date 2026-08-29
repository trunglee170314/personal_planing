-- Existing milestones remain Normal. This additive metadata does not change
-- dates, parent relations, progress, notifications, RLS or Undo capture.
begin;
alter table public.timeline_milestones
  add column if not exists is_important boolean not null default false;
notify pgrst, 'reload schema';
commit;
