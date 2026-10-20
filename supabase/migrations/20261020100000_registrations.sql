-- Registrations: a campaign kind where people fill in a form (details first) instead of buying tickets.
-- The form itself lives on the campaign (form_def); each submission is a row in `registrations`.
alter table campaigns
  add column if not exists form_def jsonb,        -- {intro, contact_mode, fields:[…], agreements:[…], payment, approval}
  add column if not exists places integer;        -- NULL = no limit; otherwise how many registrations are accepted

create table if not exists registrations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  reg_number integer not null,                    -- the registration number the person keeps ("R17")
  name text,                                      -- the person registering
  phone text,
  email text,
  answers jsonb not null default '[]',            -- [{id,label,type,value,sensitive}] — labels are snapshotted at submit time
  agreements jsonb not null default '[]',         -- [{id,kind,text,accepted}] — the exact wording agreed to
  status text not null default 'submitted' check (status in ('awaiting_payment', 'submitted', 'accepted', 'declined', 'cancelled')),
  payment_id uuid references payments(id),
  decision_note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  client_ip text,
  client_ref text,
  created_at timestamptz not null default now(),
  unique (campaign_id, reg_number)
);
create unique index if not exists registrations_client_ref_idx on registrations (campaign_id, client_ref) where client_ref is not null;
create index if not exists registrations_campaign_idx on registrations (campaign_id, created_at);
create index if not exists registrations_email_idx on registrations (lower(email));
create index if not exists registrations_phone_idx on registrations (phone);
alter table registrations enable row level security;   -- only the server (service role) reads or writes

-- Uploaded files (e.g. a baptism certificate) live in the database, not in file storage, so the nightly
-- deletion removes them with everything else.
create table if not exists registration_files (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  field_id text not null,
  filename text not null,
  mime text not null,
  size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
alter table registration_files enable row level security;
create index if not exists registration_files_reg_idx on registration_files (registration_id);

-- Takes the next registration number and a place in one step, so two people can never share a number or
-- take the last place together. Cancelled and declined registrations give their place back.
create or replace function register_claim(
  p_campaign uuid, p_name text, p_phone text, p_email text, p_answers jsonb, p_agreements jsonb,
  p_status text, p_payment uuid, p_ip text, p_client_ref text
) returns table(reg_id uuid, number integer) language plpgsql security definer set search_path = public as $$
declare v_places integer; v_next integer; v_used integer; v_id uuid;
begin
  select places into v_places from campaigns where id = p_campaign for update;
  if not found then raise exception 'NO_CAMPAIGN'; end if;
  select coalesce(max(r.reg_number), 0) + 1, count(*) filter (where r.status not in ('cancelled', 'declined'))
    into v_next, v_used from registrations r where r.campaign_id = p_campaign;
  if v_places is not null and v_used >= v_places then raise exception 'FULL'; end if;
  insert into registrations (campaign_id, reg_number, name, phone, email, answers, agreements, status, payment_id, client_ip, client_ref)
  values (p_campaign, v_next, p_name, p_phone, p_email, p_answers, p_agreements, p_status, p_payment, p_ip, p_client_ref)
  returning id into v_id;
  return query select v_id, v_next;
end $$;
revoke all on function register_claim(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text) from public, anon, authenticated;

-- Nightly deletion now also covers registrations: the person, their answers and any uploaded file go (the
-- number, dates, status and the wording they agreed to stay, so counts and the record of consent remain).
create or replace function public.retention_run(p_org uuid default null, p_days integer default 90)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
  v_ids uuid[]; v_pay integer := 0; v_tix integer := 0; v_wait integer := 0; v_reg integer := 0;
begin
  select array_agg(c.id) into v_ids from campaigns c
   where c.keep_until is not null and c.keep_until + p_days < v_today and (p_org is null or c.org_id = p_org);
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
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + p_days < v_today
     and (p.payer_name is not null or p.contact_value is not null or p.client_ip is not null);
  select count(*) into v_tix from tickets t join campaigns c on c.id = t.campaign_id
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + p_days < v_today and t.attendee_name is not null;
  select count(*) into v_reg from registrations r join campaigns c on c.id = r.campaign_id
   where c.org_id = p_org and c.keep_until is not null and c.keep_until + p_days < v_today
     and (r.name is not null or r.phone is not null or r.email is not null or r.answers <> '[]'::jsonb);
  return jsonb_build_object('payments', v_pay, 'tickets', v_tix, 'registrations', v_reg);
end $function$;
