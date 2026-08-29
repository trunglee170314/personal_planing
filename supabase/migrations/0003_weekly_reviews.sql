create table public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_start date not null,
  wins text not null default '',
  challenges text not null default '',
  next_week_focus text not null default '',
  satisfaction smallint check (satisfaction between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, week_start)
);

create index weekly_reviews_owner_week_idx
  on public.weekly_reviews(owner_user_id, week_start desc);

alter table public.weekly_reviews enable row level security;

create policy weekly_reviews_own_rows on public.weekly_reviews for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create trigger weekly_reviews_touch_updated_at before update on public.weekly_reviews
for each row execute function public.touch_updated_at();
