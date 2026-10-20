-- Waiting list for ticket events (not raffles). A campaign opts in when it is created (or later in Settings).
-- Only an email address is kept, only for as long as the list exists: the organiser emails everyone once, then clears it;
-- anything left is deleted with the campaign's other personal details by the nightly retention job.
alter table campaigns add column if not exists waiting_list boolean not null default false;

create table if not exists waiting_list (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, email)
);
alter table waiting_list enable row level security;   -- no policies: only the server (service role) ever reads or writes it

create or replace function public.retention_run(p_org uuid default null, p_days integer default 90)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
  v_ids uuid[]; v_pay integer := 0; v_tix integer := 0; v_wait integer := 0;
begin
  select array_agg(c.id) into v_ids from campaigns c
   where c.keep_until is not null and c.keep_until + p_days < v_today and (p_org is null or c.org_id = p_org);
  if v_ids is null then return jsonb_build_object('campaigns', 0, 'payments', 0, 'tickets', 0, 'waiting', 0); end if;
  -- Free-text notes (void reason, refund note) can contain a name, so they go with the identifiers.
  with u as (update payments set payer_name = null, contact_value = null, client_ip = null, refund_note = null, void_reason = null
              where campaign_id = any(v_ids) and (payer_name is not null or contact_value is not null or client_ip is not null or refund_note is not null or void_reason is not null) returning 1)
    select count(*) into v_pay from u;
  with u as (update tickets set attendee_name = null where campaign_id = any(v_ids) and attendee_name is not null returning 1)
    select count(*) into v_tix from u;
  with u as (delete from waiting_list where campaign_id = any(v_ids) returning 1)
    select count(*) into v_wait from u;
  update campaigns set data_cleared_at = now() where id = any(v_ids) and (data_cleared_at is null or v_pay + v_tix + v_wait > 0);
  return jsonb_build_object('campaigns', array_length(v_ids, 1), 'payments', v_pay, 'tickets', v_tix, 'waiting', v_wait);
end $function$;
