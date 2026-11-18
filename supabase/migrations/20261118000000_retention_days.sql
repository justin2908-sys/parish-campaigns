-- How long after a campaign's "keep the details until" date its personal details are removed is now chosen per campaign:
-- 30 to 90 days, 30 suggested for new campaigns (enough to reconcile the accounts). Every campaign that already exists stays on 90, because that is
-- what its buyers were told. The nightly job and the "waiting to be removed" count both use each campaign's own number.
-- Additive: one column, and the two retention functions are replaced (same names, same results shape; p_days is kept so old callers still work, but ignored).
alter table public.campaigns add column if not exists retention_days integer not null default 90;
alter table public.campaigns drop constraint if exists campaigns_retention_days_check;
alter table public.campaigns add constraint campaigns_retention_days_check check (retention_days between 30 and 90);
-- The column's own default stays 90 (safe: anything created without saying keeps the old behaviour, e.g. the Repository, Listings and Candles
-- internal campaigns). The create screens send 30 for new campaigns unless the person chooses otherwise.

create or replace function public.retention_run(p_org uuid default null, p_days integer default 90)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
  v_ids uuid[]; v_pay integer := 0; v_tix integer := 0; v_wait integer := 0; v_reg integer := 0;
begin
  select array_agg(c.id) into v_ids from campaigns c
   where c.keep_until is not null and c.keep_until + c.retention_days < v_today and (p_org is null or c.org_id = p_org);
  if v_ids is null then return jsonb_build_object('campaigns', 0, 'payments', 0, 'tickets', 0, 'waiting', 0, 'registrations', 0); end if;
  with u as (update payments set payer_name = null, contact_value = null, client_ip = null, refund_note = null, void_reason = null
              where campaign_id = any(v_ids) and (payer_name is not null or contact_value is not null or client_ip is not null or refund_note is not null or void_reason is not null) returning 1)
    select count(*) into v_pay from u;
  with u as (update tickets set attendee_name = null where campaign_id = any(v_ids) and attendee_name is not null returning 1)
    select count(*) into v_tix from u;
  with u as (delete from waiting_list where campaign_id = any(v_ids) returning 1)
    select count(*) into v_wait from u;
  delete from registration_files where registration_id in (select id from registrations where campaign_id = any(v_ids));
  with u as (update registrations set name = null, phone = null, email = null, answers = '[]'::jsonb, decision_note = null, client_ip = null
              where campaign_id = any(v_ids) and (name is not null or phone is not null or email is not null or answers <> '[]'::jsonb or decision_note is not null or client_ip is not null) returning 1)
    select count(*) into v_reg from u;
  update campaigns set data_cleared_at = now() where id = any(v_ids) and (data_cleared_at is null or v_pay + v_tix + v_wait + v_reg > 0);
  return jsonb_build_object('campaigns', array_length(v_ids, 1), 'payments', v_pay, 'tickets', v_tix, 'waiting', v_wait, 'registrations', v_reg);
end $function$;

create or replace function public.retention_pending(p_org uuid, p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_today date := (now() at time zone 'Europe/London')::date; v_pay integer; v_tix integer; v_reg integer;
begin
  select count(*) into v_pay from payments p join campaigns c on c.id = p.campaign_id
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + c.retention_days < v_today
     and (p.payer_name is not null or p.contact_value is not null or p.client_ip is not null);
  select count(*) into v_tix from tickets t join campaigns c on c.id = t.campaign_id
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + c.retention_days < v_today and t.attendee_name is not null;
  select count(*) into v_reg from registrations r join campaigns c on c.id = r.campaign_id
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + c.retention_days < v_today
     and (r.name is not null or r.phone is not null or r.email is not null or r.answers <> '[]'::jsonb);
  return jsonb_build_object('payments', v_pay, 'tickets', v_tix, 'registrations', v_reg);
end $function$;
