\set ON_ERROR_STOP on
insert into public.push_subscriptions(id,owner_user_id,endpoint,p256dh,auth) values
('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000002','https://web.push.apple.com/test','test','test');
insert into public.calendar_entries(id,owner_user_id,item_type,title,starts_at,ends_at,notification_offsets)
values('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002','reminder','Due test',now()-interval '5 seconds',now()+interval '14 minutes 55 seconds',array[0]);
do $$ declare schedule jsonb; job jsonb; claim jsonb; again jsonb; key text; due timestamptz; begin
  schedule:=public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002');
  if jsonb_array_length(schedule->'jobs')<>1 then raise exception 'expected one due job'; end if;
  job:=schedule->'jobs'->0; key:=job->>'job_key'; due:=(job->>'due_at')::timestamptz;
  claim:=public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due);
  if claim->>'state'<>'ready' then raise exception 'job was not claimed'; end if;
  again:=public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due);
  if again->>'state'<>'busy' then raise exception 'duplicate claim allowed'; end if;
  perform public.finish_myplan_push_job(key,(claim->>'token')::uuid,claim->'job','retry');
  again:=public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due);
  if again->>'state'<>'ready' then raise exception 'retry lease was not released'; end if;
  perform public.finish_myplan_push_job(key,(claim->>'token')::uuid,claim->'job','sent');
  if exists(select 1 from public.push_delivery_log) then raise exception 'stale lease marked delivery'; end if;
  perform public.finish_myplan_push_job(key,(again->>'token')::uuid,again->'job','sent');
  if public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due)->>'state'<>'skip' then raise exception 'sent item could be redelivered'; end if;
end $$;
insert into public.calendar_entries(id,owner_user_id,item_type,title,starts_at,ends_at,notification_offsets)
values('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000002','reminder','Moved test',now()-interval '5 seconds',now()+interval '14 minutes 55 seconds',array[0]);
do $$ declare job jsonb; key text; due timestamptz; begin
  job:=public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002')->'jobs'->0;
  key:=job->>'job_key'; due:=(job->>'due_at')::timestamptz;
  update public.calendar_entries set starts_at=now()+interval '1 hour',ends_at=now()+interval '75 minutes' where id='00000000-0000-4000-8000-000000000022';
  if public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due)->>'state'<>'skip' then raise exception 'stale queued time was sent'; end if;
  update public.calendar_entries set completed_at=now() where id='00000000-0000-4000-8000-000000000022';
  if jsonb_array_length(public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002')->'jobs')<>0 then raise exception 'completed item still scheduled'; end if;
end $$;
insert into public.calendar_entries(id,owner_user_id,item_type,title,starts_at,ends_at,notification_offsets)
values('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000002','reminder','Retry limit test',now()-interval '5 seconds',now()+interval '14 minutes 55 seconds',array[0]);
do $$ declare job jsonb; claim jsonb; key text; due timestamptz; n integer; begin
  job:=public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002')->'jobs'->0;
  key:=job->>'job_key'; due:=(job->>'due_at')::timestamptz;
  for n in 1..6 loop
    claim:=public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due);
    if claim->>'state'<>'ready' then raise exception 'retry claim % not ready',n; end if;
    perform public.finish_myplan_push_job(key,(claim->>'token')::uuid,claim->'job','retry');
  end loop;
  if public.claim_myplan_push_job('00000000-0000-4000-8000-000000000002',key,due)->>'state'<>'skip' then raise exception 'retry count was reset by re-enqueue'; end if;
  if jsonb_array_length(public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002')->'jobs')<>0 then raise exception 'failed item still scheduled'; end if;
end $$;
-- Suspending an owner cancels future schedules, without deleting their items.
update myplan_private.members set status='suspended' where user_id='00000000-0000-4000-8000-000000000002';
do $$ begin
  if public.myplan_push_owner_approved('00000000-0000-4000-8000-000000000002') then raise exception 'suspended owner can push'; end if;
  if jsonb_array_length(public.get_myplan_push_schedule('00000000-0000-4000-8000-000000000002')->'jobs')<>0 then raise exception 'suspended owner has schedule'; end if;
  if (select count(*) from public.calendar_entries)<>3 then raise exception 'suspension removed calendar data'; end if;
end $$;
select 'All scheduler, lease, deduplication, cancellation and retry assertions passed.';
