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
  gateway_hours text,
  gateway_whatsapp text,
  gateway_daily boolean not null default true
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
  created_at timestamp with time zone not null default now(),
  party_size integer not null default 1
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

alter table organizations add constraint organizations_gateway_whatsapp_check CHECK (((gateway_whatsapp IS NULL) OR (char_length(gateway_whatsapp) <= 200)));

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

alter table registrations add constraint registrations_party_size_check CHECK (((party_size >= 1) AND (party_size <= 20)));

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

CREATE OR REPLACE FUNCTION public.register_claim(p_campaign uuid, p_name text, p_phone text, p_email text, p_answers jsonb, p_agreements jsonb, p_status text, p_payment uuid, p_ip text, p_client_ref text, p_party integer DEFAULT 1)
 RETURNS TABLE(reg_id uuid, number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_places integer; v_next integer; v_used integer; v_id uuid; v_party integer := greatest(1, coalesce(p_party, 1));
begin
  select places into v_places from campaigns where id = p_campaign for update;
  if not found then raise exception 'NO_CAMPAIGN'; end if;
  select coalesce(max(r.reg_number), 0) + 1, coalesce(sum(r.party_size) filter (where r.status not in ('cancelled', 'declined')), 0)
    into v_next, v_used from registrations r where r.campaign_id = p_campaign;
  if v_places is not null and v_used >= v_places then raise exception 'FULL'; end if;
  if v_places is not null and v_used + v_party > v_places then raise exception 'TOO_MANY:%', v_places - v_used; end if;
  insert into registrations (campaign_id, reg_number, name, phone, email, answers, agreements, status, payment_id, client_ip, client_ref, party_size)
  values (p_campaign, v_next, p_name, p_phone, p_email, p_answers, p_agreements, p_status, p_payment, p_ip, p_client_ref, v_party)
  returning id into v_id;
  return query select v_id, v_next;
end $function$
;

CREATE OR REPLACE FUNCTION public.registration_used(p_campaign uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(party_size), 0)::int from registrations
   where campaign_id = p_campaign and status in ('awaiting_payment', 'submitted', 'accepted')
$function$
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


-- === SECTION 9: the Repository (parish shop), added 2026-11-09 by migration 20261109010000_repository_shop (applied to the live database; sections 1-7 above do not yet include these objects) ===

-- The Repository (parish shop) online: items, the collection settings, orders and what each order holds.
-- Additive only, and safe to run more than once: five new tables and four new functions. Nothing existing is changed.
--   * repository_items          the things on sale (imported once from SumUp's item export, then kept here)
--   * repository_settings       per organisation: on/off, the Mass slots people can collect at, the order cut-off, the next order number
--   * repository_weekends       one hidden campaign per collection weekend, so each order's payment sits in the normal payments ledger
--                               (refunds, the SumUp check, Needs Attention) and its personal details are cleared by the normal retention job
--   * repository_orders         one row per order: reference, collection date and Mass, status, total
--   * repository_order_lines    what each order holds (name and price are copied in, so the record stays right if the item is edited)
-- No name, phone or email is stored on these tables: they stay on the payment, which the nightly retention job already clears.
-- Like every table here: row level security on, no policies; only the server (service role) reads or writes. Explicit grants, as required.

create table if not exists repository_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 300),
  category text check (category is null or char_length(category) <= 60),
  sku text check (sku is null or char_length(sku) <= 60),
  price numeric(10,2) not null check (price > 0 and price <= 500),
  stock integer check (stock is null or stock >= 0),            -- null = not counted ("always available")
  available boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists repository_items_org_idx on repository_items (org_id, category, sort, name);

create table if not exists repository_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  slots jsonb not null default '[]'::jsonb,                      -- [{ "id": "s1", "label": "Saturday evening Mass", "weekday": 6, "time": "18:00" }, ...]  weekday: 6 = Saturday, 0 = Sunday
  cutoff_weekday integer not null default 3 check (cutoff_weekday between 0 and 6),   -- 3 = Wednesday
  cutoff_time text not null default '23:59' check (cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  intro_text text check (intro_text is null or char_length(intro_text) <= 400),
  next_ref integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists repository_weekends (
  org_id uuid not null references organizations(id) on delete cascade,
  weekend date not null,                                         -- the Saturday
  campaign_id uuid not null references campaigns(id) on delete cascade,
  primary key (org_id, weekend)
);

create table if not exists repository_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ref_no integer not null,
  payment_id uuid references payments(id) on delete set null,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'prepared', 'collected', 'cancelled')),
  collect_date date not null,
  slot_id text not null,
  slot_label text not null,
  total numeric(10,2) not null check (total > 0),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  client_ref text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  prepared_at timestamptz,
  collected_at timestamptz,
  cancelled_at timestamptz,
  unique (org_id, ref_no)
);
create unique index if not exists repository_orders_client_ref_idx on repository_orders (org_id, client_ref) where client_ref is not null;
create index if not exists repository_orders_collect_idx on repository_orders (org_id, collect_date);
create index if not exists repository_orders_payment_idx on repository_orders (payment_id);

create table if not exists repository_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references repository_orders(id) on delete cascade,
  item_id uuid references repository_items(id) on delete set null,
  item_name text not null,
  unit_price numeric(10,2) not null,
  qty integer not null check (qty between 1 and 50)
);
create index if not exists repository_order_lines_order_idx on repository_order_lines (order_id);

alter table repository_items enable row level security;
alter table repository_settings enable row level security;
alter table repository_weekends enable row level security;
alter table repository_orders enable row level security;
alter table repository_order_lines enable row level security;
grant select, insert, update, delete on table repository_items, repository_settings, repository_weekends, repository_orders, repository_order_lines to service_role;

-- ---------- Place an order: take the next reference and the stock in one step ----------
-- p_lines: [{ "item_id": "...", "qty": 2 }, ...]. The prices are read from the items here (never from the page); p_expected_total is
-- what the buyer was shown, and the order is refused (PRICE_CHANGED) if it no longer adds up. Stock is counted only for items that have
-- a count; two people taking the last one cannot both succeed, because the item rows are locked first (always in the same order).
create or replace function public.shop_place_order(p_org uuid, p_collect date, p_slot_id text, p_slot_label text, p_lines jsonb, p_expected_total numeric, p_client_ref text, p_payment uuid)
returns table(order_id uuid, ref_no integer, total numeric) language plpgsql security definer set search_path to 'public' as $$
declare
  v_ref integer; v_total numeric(10,2) := 0; v_order uuid; r record; v_item repository_items%rowtype;
begin
  insert into repository_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  select next_ref into v_ref from repository_settings where org_id = p_org for update;
  -- lock every item involved, in id order, then check and take the stock
  for r in select (l->>'item_id')::uuid as item_id, sum((l->>'qty')::integer)::integer as qty
             from jsonb_array_elements(p_lines) l group by 1 order by 1 loop
    select * into v_item from repository_items where id = r.item_id and org_id = p_org for update;
    if not found or not v_item.available then raise exception 'NOT_AVAILABLE:%', coalesce(v_item.name, 'an item'); end if;
    if v_item.stock is not null and v_item.stock < r.qty then raise exception 'SOLD_OUT:%:%', v_item.name, v_item.stock; end if;
    v_total := v_total + v_item.price * r.qty;
  end loop;
  if v_total <> p_expected_total then raise exception 'PRICE_CHANGED'; end if;
  update repository_settings set next_ref = next_ref + 1 where org_id = p_org;
  insert into repository_orders (org_id, ref_no, payment_id, collect_date, slot_id, slot_label, total, client_ref)
  values (p_org, v_ref, p_payment, p_collect, p_slot_id, p_slot_label, v_total, p_client_ref) returning id into v_order;
  for r in select (l->>'item_id')::uuid as item_id, sum((l->>'qty')::integer)::integer as qty
             from jsonb_array_elements(p_lines) l group by 1 order by 1 loop
    select * into v_item from repository_items where id = r.item_id;
    insert into repository_order_lines (order_id, item_id, item_name, unit_price, qty) values (v_order, r.item_id, v_item.name, v_item.price, r.qty);
    if v_item.stock is not null then update repository_items set stock = stock - r.qty, updated_at = now() where id = r.item_id; end if;
  end loop;
  return query select v_order, v_ref, v_total;
end $$;

-- ---------- Cancel an order and put its stock back (safe to run twice) ----------
create or replace function public.shop_cancel_order(p_order uuid, p_reason text, p_only_unpaid boolean default false)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_status text; r record;
begin
  select status into v_status from repository_orders where id = p_order for update;
  if not found then return 'missing'; end if;
  if v_status in ('cancelled', 'collected') then return v_status; end if;
  if p_only_unpaid and v_status <> 'awaiting_payment' then return v_status; end if;
  for r in select item_id, sum(qty)::integer as qty from repository_order_lines where order_id = p_order and item_id is not null group by item_id order by item_id loop
    update repository_items set stock = stock + r.qty, updated_at = now() where id = r.item_id and stock is not null;
  end loop;
  update repository_orders set status = 'cancelled', cancel_reason = left(p_reason, 200), cancelled_at = now() where id = p_order;
  return 'cancelled';
end $$;

-- ---------- A payment that arrives after we had already given the order up: take the stock back if it is still there ----------
create or replace function public.shop_reinstate_order(p_order uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_status text; v_reason text; r record; v_item repository_items%rowtype;
begin
  select status, cancel_reason into v_status, v_reason from repository_orders where id = p_order for update;
  if not found then return 'missing'; end if;
  if v_status <> 'cancelled' or v_reason is distinct from 'Payment not completed' then return v_status; end if;
  for r in select item_id, sum(qty)::integer as qty from repository_order_lines where order_id = p_order and item_id is not null group by item_id order by item_id loop
    select * into v_item from repository_items where id = r.item_id for update;
    if found and v_item.stock is not null and v_item.stock < r.qty then return 'SOLD_OUT:' || v_item.name; end if;
  end loop;
  for r in select item_id, sum(qty)::integer as qty from repository_order_lines where order_id = p_order and item_id is not null group by item_id order by item_id loop
    update repository_items set stock = stock - r.qty, updated_at = now() where id = r.item_id and stock is not null;
  end loop;
  update repository_orders set status = 'paid', cancel_reason = null, cancelled_at = null, paid_at = now() where id = p_order;
  return 'paid';
end $$;

revoke all on function public.shop_place_order(uuid, date, text, text, jsonb, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.shop_place_order(uuid, date, text, text, jsonb, numeric, text, uuid) to service_role;
revoke all on function public.shop_cancel_order(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.shop_cancel_order(uuid, text, boolean) to service_role;
revoke all on function public.shop_reinstate_order(uuid) from public, anon, authenticated;
grant execute on function public.shop_reinstate_order(uuid) to service_role;


-- === SECTION 10: the Repository weekly sync, small pictures and featured items, added 2026-11-09 by migration 20261109020000_repository_sync_images (applied to the live database) ===

-- The Repository: the weekly SumUp sync, small product pictures, and "featured" items.
-- Additive only, and safe to run more than once: new columns on two of the Repository's own tables, one index, one public storage bucket.
--   * repository_items gets SumUp's permanent ids (so a weekly export updates the same item, not a copy), the barcode, where the picture came
--     from (image_src) and the small picture we made from it (image_path, in the 'repository' bucket), "featured", and when it was first added.
--   * repository_settings remembers when the stock was last brought up to date from SumUp.
--   * The 'repository' storage bucket holds only the small compressed pictures (WebP or JPEG, 100 KB at most each). It is public to read, like any
--     product picture on a shop page; only the server (service role) can put files in it.
alter table repository_items
  add column if not exists sumup_item_id text check (sumup_item_id is null or char_length(sumup_item_id) <= 80),
  add column if not exists sumup_variant_id text check (sumup_variant_id is null or char_length(sumup_variant_id) <= 80),
  add column if not exists barcode text check (barcode is null or char_length(barcode) <= 60),
  add column if not exists image_src text check (image_src is null or char_length(image_src) <= 300),
  add column if not exists image_path text check (image_path is null or char_length(image_path) <= 200),
  add column if not exists image_done_src text check (image_done_src is null or char_length(image_done_src) <= 300),
  add column if not exists featured boolean not null default false,
  add column if not exists added_at timestamptz not null default now(),
  add column if not exists seen_at timestamptz;
create unique index if not exists repository_items_variant_idx on repository_items (org_id, sumup_variant_id) where sumup_variant_id is not null;

alter table repository_settings
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_sync_note text check (last_sync_note is null or char_length(last_sync_note) <= 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('repository', 'repository', true, 102400, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;


-- === SECTION 11: Listings (the parish classifieds), added 2026-11-10 by migration 20261110000000_listings (applied to the live database) ===

-- Listings: a parish classifieds. Parishioners offer things or services (for sale, free, or a service) for 1 to 4 weeks; the office approves each
-- one first; people contact the lister by email only (the address is never shown on the page; it is handed over by a "copy" button).
-- Additive only, and safe to run more than once: five new tables, one function, one public storage bucket. Nothing existing is changed.
--   * listings_settings   per organisation: on/off, a welcome line, and the three numbers the suggested listing fee is worked out from
--   * listings            one row per listing (the lister's email is kept only until the listing has ended; see the sweep in api.js)
--   * listing_events      a view / contact / report counted once per visitor per day (the visitor is a scrambled address, never an IP)
--   * listing_reports     why somebody reported a listing, for the office
--   * listing_months      one hidden campaign per month, so each listing fee's payment sits in the normal payments ledger (refunds, the SumUp
--                         check, Needs Attention) and its personal details are cleared by the normal retention job
--   * 'listings' storage bucket: the small compressed pictures only (WebP or JPEG, 150 KB at most each). Public to read, like any ad on a notice
--     board; only the server (service role) can put files in it.
-- Like every table here: row level security on, no policies; only the server (service role) reads or writes. Explicit grants, as required.

create table if not exists listings_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  intro_text text check (intro_text is null or char_length(intro_text) <= 300),
  price_base numeric(6,2) not null default 3.00 check (price_base between 0 and 50),
  price_per_extra_week numeric(6,2) not null default 1.50 check (price_per_extra_week between 0 and 50),
  price_per_image numeric(6,2) not null default 0.50 check (price_per_image between 0 and 20),
  updated_at timestamptz not null default now()
);

create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  token text not null unique check (char_length(token) = 32),                 -- the lister's private link to their own listing
  title text not null check (char_length(title) between 5 and 70),
  description text not null default '' check (char_length(description) <= 1200),
  category text not null check (char_length(category) between 1 and 40),
  kind text not null check (kind in ('sell', 'free', 'service')),
  price_text text check (price_text is null or char_length(price_text) <= 40),
  display_name text check (display_name is null or char_length(display_name) <= 40),
  email text check (email is null or char_length(email) <= 254),
  days integer not null check (days between 7 and 30),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'pending_review', 'live', 'rejected', 'withdrawn', 'removed', 'expired', 'cancelled')),
  images jsonb not null default '[]'::jsonb,                                  -- [{ "t": thumbnail path, "f": full-size path }, ...] in the 'listings' bucket
  fee numeric(10,2) not null default 0 check (fee >= 0),
  payment_id uuid references payments(id) on delete set null,
  featured boolean not null default false,
  views integer not null default 0,
  contacts integer not null default 0,
  reports integer not null default 0,
  review_note text check (review_note is null or char_length(review_note) <= 300),
  agreed_version integer,
  agreed_at timestamptz,
  client_ref text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  purged_at timestamptz
);
create unique index if not exists listings_client_ref_idx on listings (org_id, client_ref) where client_ref is not null;
create index if not exists listings_org_status_idx on listings (org_id, status, ends_at);
create index if not exists listings_payment_idx on listings (payment_id);

create table if not exists listing_events (
  listing_id uuid not null references listings(id) on delete cascade,
  kind text not null check (kind in ('view', 'contact', 'report')),
  day date not null,
  ip_hash text not null,
  primary key (listing_id, kind, day, ip_hash)
);

create table if not exists listing_reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  reason text not null check (char_length(reason) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists listing_reports_listing_idx on listing_reports (listing_id);

create table if not exists listing_months (
  org_id uuid not null references organizations(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  primary key (org_id, month)
);

alter table listings_settings enable row level security;
alter table listings enable row level security;
alter table listing_events enable row level security;
alter table listing_reports enable row level security;
alter table listing_months enable row level security;
grant select, insert, update, delete on table listings_settings, listings, listing_events, listing_reports, listing_months to service_role;

-- Count a view, a contact or a report once per visitor per day. Returns true only when it was new, so the number goes up by one and no more.
create or replace function public.listing_event(p_listing uuid, p_kind text, p_day date, p_ip text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_rows integer;
begin
  insert into listing_events (listing_id, kind, day, ip_hash) values (p_listing, p_kind, p_day, p_ip) on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  if p_kind = 'view' then update listings set views = views + 1 where id = p_listing;
  elsif p_kind = 'contact' then update listings set contacts = contacts + 1 where id = p_listing;
  elsif p_kind = 'report' then update listings set reports = reports + 1 where id = p_listing;
  end if;
  return true;
end $$;
revoke all on function public.listing_event(uuid, text, date, text) from public, anon, authenticated;
grant execute on function public.listing_event(uuid, text, date, text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listings', 'listings', true, 153600, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

-- === SECTION 12: Light a Candle and the Thursday email, added 2026-11-11 by migration 20261111000000_candles_digest (applied to the live database) ===
-- Light a Candle: parishioners ask for a candle to be lit at one of the parish's candle stands on a chosen day, and give an offering (£1.50 to £5 a candle)
-- by card on the page. Also the Thursday email: a reminder sent to the parish office listing the candles for the coming week and the Repository orders for
-- the coming weekend.
-- Additive only, and safe to run more than once: four new tables and one function. Nothing existing is changed.
--   * candle_settings   per organisation: on/off, the candle stands (altars), a welcome line, the order cut-off and the next request number
--   * candle_requests   one row per request: reference, day, altar, number of candles, offering, status. The person's name and contact stay on the
--                       payment only (never here); the optional intention (who it is for) is kept only until a month after the day, then cleared by the sweep
--   * candle_months     one hidden campaign per month, so each offering's payment sits in the normal payments ledger (refunds, the SumUp check, Needs
--                       Attention) and its personal details are cleared by the normal retention job
--   * weekly_digest     per organisation: whether the Thursday email is on, who it goes to, and how the last one went
-- Like every table here: row level security on, no policies; only the server (service role) reads or writes. Explicit grants, as required.

create table if not exists candle_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  altars jsonb not null default '[{"id":"mary","name":"Altar of Our Lady","active":true},{"id":"anthony","name":"Altar of St Anthony of Padua","active":true}]'::jsonb,
  intro_text text check (intro_text is null or char_length(intro_text) <= 300),
  cutoff_weekday integer not null default 3 check (cutoff_weekday between 0 and 6),
  cutoff_time text not null default '23:59' check (cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  next_ref integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists candle_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ref_no integer not null,
  payment_id uuid references payments(id) on delete set null,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'lit', 'cancelled')),
  light_date date not null,
  altar_id text not null,
  altar_name text not null,
  candles integer not null check (candles between 1 and 10),
  per_candle numeric(5,2) not null check (per_candle >= 0 and per_candle <= 5),
  total numeric(10,2) not null check (total > 0),
  intention text check (intention is null or char_length(intention) <= 120),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  client_ref text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  lit_at timestamptz,
  cancelled_at timestamptz,
  unique (org_id, ref_no)
);
create unique index if not exists candle_requests_client_ref_idx on candle_requests (org_id, client_ref) where client_ref is not null;
create index if not exists candle_requests_date_idx on candle_requests (org_id, light_date);
create index if not exists candle_requests_payment_idx on candle_requests (payment_id);

create table if not exists candle_months (
  org_id uuid not null references organizations(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  primary key (org_id, month)
);

create table if not exists weekly_digest (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  to_email text check (to_email is null or char_length(to_email) <= 254),
  last_week_start date,                                   -- the Monday of the week the last email covered
  last_attempt_at timestamptz,
  last_sent_at timestamptz,
  last_status text check (last_status is null or last_status in ('sent', 'failed')),
  last_note text check (last_note is null or char_length(last_note) <= 300),
  updated_at timestamptz not null default now()
);

alter table candle_settings enable row level security;
alter table candle_requests enable row level security;
alter table candle_months enable row level security;
alter table weekly_digest enable row level security;
grant select, insert, update, delete on table candle_settings, candle_requests, candle_months, weekly_digest to service_role;

-- The next request number for an organisation, taken in one step (two requests at the same moment never get the same number).
create or replace function public.candle_next_ref(p_org uuid)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_ref integer;
begin
  insert into candle_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  update candle_settings set next_ref = next_ref + 1 where org_id = p_org returning next_ref - 1 into v_ref;
  return v_ref;
end $$;
revoke all on function public.candle_next_ref(uuid) from public, anon, authenticated;
grant execute on function public.candle_next_ref(uuid) to service_role;

-- ===== 13. Hearts (migration 20261112000000_hearts) =====
alter table listings add column if not exists hearts integer not null default 0;
alter table repository_items add column if not exists hearts integer not null default 0;

create table if not exists hearts (
  kind text not null check (kind in ('listing', 'item')),
  target_id uuid not null,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  primary key (kind, target_id, ip_hash)
);
create index if not exists hearts_created_idx on hearts (created_at);

alter table hearts enable row level security;
grant select, insert, update, delete on table hearts to service_role;

-- Put a heart on (p_on = true) or take it off (false), once per visitor per thing, and return how many hearts it now has.
-- The stored count is recalculated from the table each time, so it can never drift.
create or replace function public.heart_set(p_kind text, p_target uuid, p_ip text, p_on boolean)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer;
begin
  if p_kind not in ('listing', 'item') then return 0; end if;
  if p_on then
    insert into hearts (kind, target_id, ip_hash) values (p_kind, p_target, p_ip) on conflict do nothing;
  else
    delete from hearts where kind = p_kind and target_id = p_target and ip_hash = p_ip;
  end if;
  select count(*) into v_n from hearts where kind = p_kind and target_id = p_target;
  if p_kind = 'listing' then update listings set hearts = v_n where id = p_target;
  else update repository_items set hearts = v_n where id = p_target;
  end if;
  return v_n;
end $$;
revoke all on function public.heart_set(text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.heart_set(text, uuid, text, boolean) to service_role;
