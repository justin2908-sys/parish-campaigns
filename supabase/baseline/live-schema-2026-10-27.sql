-- RAISE / Parish Campaigns: the complete structure of the live database (project "parish-campaigns"), saved 2026-10-27.
--
-- WHY THIS EXISTS. Until 2026-10-23 the repository held 20 migration files while the live database had been built by 34 changes: 14
-- had been applied directly and never saved as files. The database was the only complete record of its own structure. This file is
-- that record, so a NEW, EMPTY database (a staging copy, or a dedicated install for one customer) can be built from the repository.
--
-- HOW TO USE. Run it once, whole, on a new empty Supabase project (SQL Editor). It is NOT a migration for the live database (which
-- already has all of this) and it is not safe to run twice. Afterwards create the organisation and its first users in the app.
-- Changes from now on are saved as numbered files in supabase/migrations/, and only ever applied from those files.
--
-- CHECKED. Each section below is fingerprinted against the live database (see supabase/baseline/README.md). It holds structure only:
-- no organisation, user, campaign, payment or ticket data.
--
-- NOT HERE (set up by hand on a new project): the extensions below, the nightly deletion job (last section), and the unused storage
-- bucket "payment-evidence" (nothing uses it any more).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_cron;

-- === SECTION 1: tables ===

create table public.campaigns (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  active boolean not null default true,
  binned boolean not null default false,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  details_text text,
  public_only boolean not null default false,
  age_restricted boolean not null default true,
  public_page_enabled boolean not null default true,
  physical_payment_methods text[] not null default '{cash,machine,link}'::text[],
  online_payment_methods text[] not null default '{cash,machine,link}'::text[],
  default_ticket_qty integer not null default 0,
  kind text not null default 'event'::text,
  opens_on date,
  closes_on date,
  keep_until date,
  is_draft boolean not null default false,
  data_cleared_at timestamp with time zone,
  waiting_list boolean not null default false,
  form_def jsonb,
  places integer,
  listed_on_gateway boolean not null default false,
  gateway_cta text
);

create table public.cash_recon (
  id uuid not null default gen_random_uuid(),
  seller_id uuid not null,
  campaign_id uuid not null,
  amount_received numeric(10,2) not null,
  confirmed_by uuid not null,
  fully_matched boolean not null default false,
  surplus_amount numeric(10,2) not null default 0,
  shortfall_amount numeric(10,2) not null default 0,
  created_at timestamp with time zone not null default now()
);

create table public.gateway_announcements (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  message text not null,
  link_url text,
  urgent boolean not null default false,
  starts_at timestamp with time zone not null default now(),
  ends_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.gateway_items (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  section text not null,
  label text not null,
  url text not null,
  cta text,
  starts_on date not null,
  ends_on date not null,
  listed boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.gateway_links (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  "position" integer not null,
  label text not null,
  sub text not null default ''::text,
  url text not null,
  updated_by uuid,
  updated_at timestamp with time zone not null default now()
);

create table public.gateway_order (
  org_id uuid not null,
  section text not null,
  item_ids text[] not null,
  updated_at timestamp with time zone not null default now()
);

create table public.organizations (
  id uuid not null default gen_random_uuid(),
  name text not null,
  created_at timestamp with time zone not null default now(),
  address text,
  thank_you_text text,
  contact_email text,
  privacy_url text,
  lottery_reg_number text,
  lottery_authority text,
  lottery_valid_until date,
  slug text,
  gateway_enabled boolean not null default false,
  timezone text not null default 'Europe/London'::text,
  display_name text,
  gateway_phone text,
  gateway_hours text
);

create table public.payments (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  method text not null,
  amount numeric(10,2) not null,
  status text not null default 'pending'::text,
  seller_id uuid,
  payer_name text,
  sold_at timestamp with time zone not null default now(),
  sumup_checkout_id text,
  sumup_checkout_ref text,
  sumup_transaction_code text,
  sumup_transaction_id text,
  resend_count integer not null default 0,
  cash_confirmed_by uuid,
  cash_confirmed_at timestamp with time zone,
  cash_recon_batch_id uuid,
  voided boolean not null default false,
  voided_by uuid,
  voided_at timestamp with time zone,
  void_reason text,
  photo_path text,
  created_at timestamp with time zone not null default now(),
  contact_value text,
  contact_channel text,
  link_url text,
  link_shared_at timestamp with time zone,
  client_ref text,
  client_ip text,
  ticket_snapshot jsonb,
  refund_amount numeric(10,2),
  refund_note text,
  refunded_at timestamp with time zone,
  refunded_by uuid,
  attention_note text,
  attention_done_at timestamp with time zone,
  attention_done_by uuid
);

create table public.privacy_requests (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid,
  kind text not null,
  subject_masked text not null,
  subject_hash text not null,
  found_payments integer not null default 0,
  found_tickets integer not null default 0,
  created_at timestamp with time zone not null default now()
);

create table public.rate_limits (
  key text not null,
  hits integer not null default 0,
  window_start timestamp with time zone not null default now()
);

create table public.registration_files (
  id uuid not null default gen_random_uuid(),
  registration_id uuid not null,
  field_id text not null,
  filename text not null,
  mime text not null,
  size integer not null,
  data bytea not null,
  created_at timestamp with time zone not null default now()
);

create table public.registrations (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  reg_number integer not null,
  name text,
  phone text,
  email text,
  answers jsonb not null default '[]'::jsonb,
  agreements jsonb not null default '[]'::jsonb,
  status text not null default 'submitted'::text,
  payment_id uuid,
  decision_note text,
  decided_by uuid,
  decided_at timestamp with time zone,
  client_ip text,
  client_ref text,
  created_at timestamp with time zone not null default now()
);

create table public.ticket_blocks (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  type text not null,
  label text not null default 'Main'::text,
  range_start integer,
  range_end integer,
  created_at timestamp with time zone not null default now(),
  number_prefix text not null default ''::text
);

create table public.tickets (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  block_id uuid not null,
  ticket_number integer not null,
  tier_id uuid,
  status text not null default 'unsold'::text,
  payment_id uuid,
  sold_by uuid,
  sold_at timestamp with time zone,
  attendee_name text,
  created_at timestamp with time zone not null default now()
);

create table public.tiers (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  name text not null,
  price numeric(10,2) not null,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now()
);

create table public.user_campaigns (
  user_id uuid not null,
  campaign_id uuid not null,
  assigned_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.users (
  id uuid not null default gen_random_uuid(),
  org_id uuid,
  mobile text not null,
  name text not null,
  role text not null,
  password_hash text not null,
  active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  consent_version integer not null default 0,
  consented_at timestamp with time zone,
  confidentiality_version integer not null default 0,
  confidentiality_at timestamp with time zone
);

create table public.waiting_list (
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  email text not null,
  created_at timestamp with time zone not null default now()
);

-- === SECTION 2: keys, unique rules and checks ===

alter table campaigns add constraint campaigns_default_ticket_qty_range CHECK (((default_ticket_qty >= 0) AND (default_ticket_qty <= 50)));

alter table campaigns add constraint campaigns_gateway_cta_check CHECK (((gateway_cta IS NULL) OR (char_length(gateway_cta) <= 24)));

alter table campaigns add constraint campaigns_kind_check CHECK ((kind = ANY (ARRAY['raffle'::text, 'event'::text, 'registration'::text])));

alter table campaigns add constraint campaigns_pkey PRIMARY KEY (id);

alter table cash_recon add constraint cash_recon_pkey PRIMARY KEY (id);

alter table gateway_announcements add constraint gateway_announcements_check CHECK (((ends_at IS NULL) OR (ends_at > starts_at)));

alter table gateway_announcements add constraint gateway_announcements_link_url_check CHECK (((link_url IS NULL) OR ((char_length(link_url) <= 2000) AND (link_url ~ '^https://'::text))));

alter table gateway_announcements add constraint gateway_announcements_message_check CHECK (((char_length(message) >= 1) AND (char_length(message) <= 200)));

alter table gateway_announcements add constraint gateway_announcements_pkey PRIMARY KEY (id);

alter table gateway_items add constraint gateway_items_check CHECK ((ends_on >= starts_on));

alter table gateway_items add constraint gateway_items_cta_check CHECK (((cta IS NULL) OR (char_length(cta) <= 24)));

alter table gateway_items add constraint gateway_items_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60)));

alter table gateway_items add constraint gateway_items_pkey PRIMARY KEY (id);

alter table gateway_items add constraint gateway_items_section_check CHECK ((section = ANY (ARRAY['involved'::text, 'registration'::text])));

alter table gateway_items add constraint gateway_items_url_check CHECK (((char_length(url) <= 2000) AND (url ~ '^https://'::text)));

alter table gateway_links add constraint gateway_links_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60)));

alter table gateway_links add constraint gateway_links_org_id_position_key UNIQUE (org_id, "position");

alter table gateway_links add constraint gateway_links_pkey PRIMARY KEY (id);

alter table gateway_links add constraint gateway_links_position_check CHECK ((("position" >= 1) AND ("position" <= 3)));

alter table gateway_links add constraint gateway_links_sub_check CHECK ((char_length(sub) <= 60));

alter table gateway_links add constraint gateway_links_url_check CHECK (((char_length(url) <= 2000) AND (url ~ '^https://'::text)));

alter table gateway_order add constraint gateway_order_pkey PRIMARY KEY (org_id, section);

alter table gateway_order add constraint gateway_order_section_check CHECK ((section = ANY (ARRAY['involved'::text, 'registration'::text])));

alter table organizations add constraint organizations_display_name_check CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 80))));

alter table organizations add constraint organizations_gateway_hours_check CHECK (((gateway_hours IS NULL) OR (char_length(gateway_hours) <= 120)));

alter table organizations add constraint organizations_gateway_phone_check CHECK (((gateway_phone IS NULL) OR (char_length(gateway_phone) <= 40)));

alter table organizations add constraint organizations_pkey PRIMARY KEY (id);

alter table organizations add constraint organizations_slug_check CHECK (((slug IS NULL) OR (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'::text)));

alter table payments add constraint payments_contact_channel_check CHECK ((contact_channel = ANY (ARRAY['sms'::text, 'whatsapp'::text, 'email'::text])));

alter table payments add constraint payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'machine'::text, 'link'::text])));

alter table payments add constraint payments_pkey PRIMARY KEY (id);

alter table payments add constraint payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'void'::text])));

alter table privacy_requests add constraint privacy_requests_kind_check CHECK ((kind = ANY (ARRAY['search'::text, 'export'::text, 'erase'::text])));

alter table privacy_requests add constraint privacy_requests_pkey PRIMARY KEY (id);

alter table rate_limits add constraint rate_limits_pkey PRIMARY KEY (key);

alter table registration_files add constraint registration_files_pkey PRIMARY KEY (id);

alter table registrations add constraint registrations_campaign_id_reg_number_key UNIQUE (campaign_id, reg_number);

alter table registrations add constraint registrations_pkey PRIMARY KEY (id);

alter table registrations add constraint registrations_status_check CHECK ((status = ANY (ARRAY['awaiting_payment'::text, 'submitted'::text, 'accepted'::text, 'declined'::text, 'cancelled'::text])));

alter table ticket_blocks add constraint blocks_need_range CHECK (((range_start IS NOT NULL) AND (range_end IS NOT NULL) AND (range_end >= range_start)));

alter table ticket_blocks add constraint ticket_blocks_pkey PRIMARY KEY (id);

alter table ticket_blocks add constraint ticket_blocks_type_check CHECK ((type = ANY (ARRAY['physical'::text, 'digital'::text])));

alter table tickets add constraint tickets_block_id_ticket_number_key UNIQUE (block_id, ticket_number);

alter table tickets add constraint tickets_pkey PRIMARY KEY (id);

alter table tickets add constraint tickets_status_check CHECK ((status = ANY (ARRAY['unsold'::text, 'cash_pending'::text, 'held'::text, 'paid'::text])));

alter table tiers add constraint tiers_pkey PRIMARY KEY (id);

alter table tiers add constraint tiers_price_check CHECK ((price >= (0)::numeric));

alter table user_campaigns add constraint user_campaigns_pkey PRIMARY KEY (user_id, campaign_id);

alter table users add constraint org_required_unless_platform_owner CHECK ((((role = 'platform_owner'::text) AND (org_id IS NULL)) OR ((role <> 'platform_owner'::text) AND (org_id IS NOT NULL))));

alter table users add constraint users_mobile_key UNIQUE (mobile);

alter table users add constraint users_pkey PRIMARY KEY (id);

alter table users add constraint users_role_check CHECK ((role = ANY (ARRAY['platform_owner'::text, 'superadmin'::text, 'admin'::text, 'seller'::text, 'finance'::text, 'priest'::text])));

alter table waiting_list add constraint waiting_list_campaign_id_email_key UNIQUE (campaign_id, email);

alter table waiting_list add constraint waiting_list_pkey PRIMARY KEY (id);

-- === SECTION 3: links between tables ===

alter table campaigns add constraint campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

alter table campaigns add constraint campaigns_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);

alter table cash_recon add constraint cash_recon_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table cash_recon add constraint cash_recon_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES users(id);

alter table cash_recon add constraint cash_recon_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES users(id);

alter table gateway_announcements add constraint gateway_announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

alter table gateway_announcements add constraint gateway_announcements_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

alter table gateway_items add constraint gateway_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

alter table gateway_items add constraint gateway_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

alter table gateway_links add constraint gateway_links_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

alter table gateway_links add constraint gateway_links_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);

alter table gateway_order add constraint gateway_order_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

alter table payments add constraint payments_attention_done_by_fkey FOREIGN KEY (attention_done_by) REFERENCES users(id);

alter table payments add constraint payments_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table payments add constraint payments_cash_confirmed_by_fkey FOREIGN KEY (cash_confirmed_by) REFERENCES users(id);

alter table payments add constraint payments_cash_recon_batch_id_fkey FOREIGN KEY (cash_recon_batch_id) REFERENCES cash_recon(id);

alter table payments add constraint payments_refunded_by_fkey FOREIGN KEY (refunded_by) REFERENCES users(id);

alter table payments add constraint payments_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES users(id);

alter table payments add constraint payments_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES users(id);

alter table privacy_requests add constraint privacy_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);

alter table privacy_requests add constraint privacy_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

alter table registration_files add constraint registration_files_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE CASCADE;

alter table registrations add constraint registrations_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;

alter table registrations add constraint registrations_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id);

alter table registrations add constraint registrations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id);

alter table ticket_blocks add constraint ticket_blocks_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table tickets add constraint tickets_block_id_fkey FOREIGN KEY (block_id) REFERENCES ticket_blocks(id);

alter table tickets add constraint tickets_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table tickets add constraint tickets_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id);

alter table tickets add constraint tickets_sold_by_fkey FOREIGN KEY (sold_by) REFERENCES users(id);

alter table tickets add constraint tickets_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES tiers(id);

alter table tiers add constraint tiers_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table user_campaigns add constraint user_campaigns_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES users(id);

alter table user_campaigns add constraint user_campaigns_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

alter table user_campaigns add constraint user_campaigns_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

alter table users add constraint users_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

alter table users add constraint users_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);

alter table waiting_list add constraint waiting_list_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;

-- === SECTION 4: indexes ===

CREATE INDEX campaigns_org_id_idx ON public.campaigns USING btree (org_id);

CREATE INDEX gateway_announcements_org_idx ON public.gateway_announcements USING btree (org_id, starts_at DESC);

CREATE INDEX gateway_items_org_idx ON public.gateway_items USING btree (org_id);

CREATE UNIQUE INDEX organizations_slug_idx ON public.organizations USING btree (lower(slug)) WHERE (slug IS NOT NULL);

CREATE INDEX payments_campaign_id_idx ON public.payments USING btree (campaign_id);

CREATE INDEX payments_client_ip_pending_idx ON public.payments USING btree (client_ip) WHERE ((client_ip IS NOT NULL) AND (status = 'pending'::text));

CREATE UNIQUE INDEX payments_client_ref_key ON public.payments USING btree (client_ref) WHERE (client_ref IS NOT NULL);

CREATE INDEX payments_seller_id_idx ON public.payments USING btree (seller_id);

CREATE INDEX payments_status_idx ON public.payments USING btree (status);

CREATE INDEX privacy_requests_org_idx ON public.privacy_requests USING btree (org_id, created_at DESC);

CREATE INDEX registration_files_reg_idx ON public.registration_files USING btree (registration_id);

CREATE INDEX registrations_campaign_idx ON public.registrations USING btree (campaign_id, created_at);

CREATE UNIQUE INDEX registrations_client_ref_idx ON public.registrations USING btree (campaign_id, client_ref) WHERE (client_ref IS NOT NULL);

CREATE INDEX registrations_email_idx ON public.registrations USING btree (lower(email));

CREATE INDEX registrations_phone_idx ON public.registrations USING btree (phone);

CREATE INDEX ticket_blocks_campaign_id_idx ON public.ticket_blocks USING btree (campaign_id);

CREATE INDEX tickets_campaign_id_idx ON public.tickets USING btree (campaign_id);

CREATE UNIQUE INDEX tickets_campaign_id_ticket_number_key ON public.tickets USING btree (campaign_id, ticket_number);

CREATE INDEX tickets_payment_id_idx ON public.tickets USING btree (payment_id);

CREATE INDEX tickets_status_idx ON public.tickets USING btree (status);

CREATE INDEX tiers_campaign_id_idx ON public.tiers USING btree (campaign_id);

-- === SECTION 5: row level security (on, with no policies: only the server reads or writes) ===

alter table public.campaigns enable row level security;

alter table public.cash_recon enable row level security;

alter table public.gateway_announcements enable row level security;

alter table public.gateway_items enable row level security;

alter table public.gateway_links enable row level security;

alter table public.gateway_order enable row level security;

alter table public.organizations enable row level security;

alter table public.payments enable row level security;

alter table public.privacy_requests enable row level security;

alter table public.rate_limits enable row level security;

alter table public.registration_files enable row level security;

alter table public.registrations enable row level security;

alter table public.ticket_blocks enable row level security;

alter table public.tickets enable row level security;

alter table public.tiers enable row level security;

alter table public.user_campaigns enable row level security;

alter table public.users enable row level security;

alter table public.waiting_list enable row level security;

-- === SECTION 6: functions ===

CREATE OR REPLACE FUNCTION public.claim_lowest_available_tickets(p_block_id uuid, p_tier_ids uuid[], p_status text, p_payment_id uuid, p_sold_by uuid)
 RETURNS TABLE(ticket_number integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_count int := coalesce(array_length(p_tier_ids, 1), 0);
  v_ids uuid[];
begin
  if v_count = 0 then
    raise exception 'CLAIM_FAILED: nothing requested';
  end if;

  select array_agg(id order by tn) into v_ids
  from (
    select id, tickets.ticket_number as tn from tickets
    where block_id = p_block_id and status = 'unsold'
    order by tn
    limit v_count
    for update skip locked
  ) sub;

  if v_ids is null or array_length(v_ids, 1) <> v_count then
    raise exception 'CLAIM_FAILED: only % of % requested ticket(s) available', coalesce(array_length(v_ids, 1), 0), v_count;
  end if;

  return query
  update tickets t
  set tier_id = x.tier_id,
      status = p_status,
      payment_id = p_payment_id,
      sold_by = p_sold_by,
      sold_at = now()
  from (select unnest(v_ids) as id, unnest(p_tier_ids) as tier_id) x
  where t.id = x.id
  returning t.ticket_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_specific_tickets(p_campaign_id uuid, p_items jsonb, p_status text, p_payment_id uuid, p_sold_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_expected int;
  v_updated int;
begin
  select jsonb_array_length(p_items) into v_expected;

  with items as (
    select (elem->>'ticket_number')::int as ticket_number, (elem->>'tier_id')::uuid as tier_id
    from jsonb_array_elements(p_items) as elem
  ), upd as (
    update tickets t
    set tier_id = items.tier_id,
        status = p_status,
        payment_id = p_payment_id,
        sold_by = p_sold_by,
        sold_at = now()
    from items
    where t.campaign_id = p_campaign_id
      and t.ticket_number = items.ticket_number
      and t.status = 'unsold'
    returning t.ticket_number
  )
  select count(*) into v_updated from upd;

  if v_updated <> v_expected then
    raise exception 'CLAIM_FAILED: expected % ticket(s), claimed %', v_expected, v_updated;
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.random_unsold_numbers(p_campaign_id uuid, p_block_id uuid, p_count integer, p_exclude integer[])
 RETURNS SETOF integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select t.ticket_number
  from tickets t
  join ticket_blocks b on b.id = t.block_id
  where t.campaign_id = p_campaign_id
    and b.type = 'digital'
    and t.status = 'unsold'
    and (p_block_id is null or t.block_id = p_block_id)
    and not (t.ticket_number = any(coalesce(p_exclude, '{}'::int[])))
  order by random()
  limit greatest(least(p_count, 20), 0)
$function$
;

CREATE OR REPLACE FUNCTION public.rate_hit(p_key text, p_window_seconds integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_hits int;
begin
  insert into rate_limits as r (key, hits, window_start) values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning r.hits into v_hits;
  return v_hits;
end $function$
;

CREATE OR REPLACE FUNCTION public.rate_peek(p_key text, p_window_seconds integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce((select r.hits from rate_limits r where r.key = p_key and r.window_start >= now() - make_interval(secs => p_window_seconds)), 0)
$function$
;

CREATE OR REPLACE FUNCTION public.rate_prune()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$ delete from rate_limits where window_start < now() - interval '2 days' $function$
;

CREATE OR REPLACE FUNCTION public.rate_reset(p_key text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$ delete from rate_limits where key = p_key $function$
;

CREATE OR REPLACE FUNCTION public.register_claim(p_campaign uuid, p_name text, p_phone text, p_email text, p_answers jsonb, p_agreements jsonb, p_status text, p_payment uuid, p_ip text, p_client_ref text)
 RETURNS TABLE(reg_id uuid, number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.retention_pending(p_org uuid, p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.retention_run(p_org uuid DEFAULT NULL::uuid, p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.shrink_block(p_block_id uuid, p_new_end integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_start integer; v_end integer; v_total integer; v_deleted integer;
begin
  select range_start, range_end into v_start, v_end from ticket_blocks where id = p_block_id for update;
  if not found then raise exception 'BLOCK_NOT_FOUND'; end if;
  if p_new_end >= v_end or p_new_end < v_start then raise exception 'BAD_END'; end if;
  select count(*) into v_total from tickets where block_id = p_block_id and ticket_number > p_new_end;
  delete from tickets where block_id = p_block_id and ticket_number > p_new_end and status = 'unsold' and payment_id is null;
  get diagnostics v_deleted = row_count;
  -- Someone sold or reserved one of them since the caller looked: undo the whole thing.
  if v_deleted <> v_total then raise exception 'IN_USE'; end if;
  update ticket_blocks set range_end = p_new_end where id = p_block_id;
  return v_deleted;
end $function$
;

CREATE OR REPLACE FUNCTION public.ticket_rollup(p_campaign_ids uuid[])
 RETURNS TABLE(status text, tier_id uuid, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.status::text, t.tier_id, count(*)::bigint
  from tickets t
  where t.campaign_id = any(p_campaign_ids)
  group by t.status, t.tier_id
$function$
;

-- === SECTION 7: what the server (service role) may touch ===

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.campaigns to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.cash_recon to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gateway_announcements to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gateway_items to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gateway_links to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gateway_order to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.organizations to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.payments to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.privacy_requests to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.rate_limits to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.registration_files to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.registrations to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ticket_blocks to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.tickets to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.tiers to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.user_campaigns to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.users to service_role;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.waiting_list to service_role;

-- === SECTION 8: the nightly deletion of personal details (every night at 03:30 UTC; see retention_run) ===

select cron.schedule('retention-daily', '30 3 * * *', 'select public.retention_run()');
