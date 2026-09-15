-- Parish Campaigns — generalized schema (Organization -> Campaign -> Tiers/Blocks -> Tickets/Payments)
-- Carries forward the live BBQ ticketing data model, generalized per docs/scope-v1.0.md sections 4 and 8.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organizations (tenants). Platform Owner is global and has no org_id.
-- ---------------------------------------------------------------------------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Users. role: platform_owner (org_id null) | superadmin | admin | seller (org_id required).
-- ---------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id),
  mobile text not null unique,
  name text not null,
  role text not null check (role in ('platform_owner', 'superadmin', 'admin', 'seller')),
  password_hash text not null,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint org_required_unless_platform_owner check (
    (role = 'platform_owner' and org_id is null) or
    (role <> 'platform_owner' and org_id is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Campaigns (generalizes bbq_series — no more hardcoded adult/child pricing here).
-- ---------------------------------------------------------------------------
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  active boolean not null default true,
  binned boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index campaigns_org_id_idx on campaigns(org_id);

-- Per-user exclusion list: a row here means this campaign is explicitly DISABLED for this
-- seller. Default is full access to every active campaign in their own org.
create table user_campaigns (
  user_id uuid not null references users(id),
  campaign_id uuid not null references campaigns(id),
  assigned_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (user_id, campaign_id)
);

-- ---------------------------------------------------------------------------
-- Tiers: replaces the hardcoded adult_price/child_price columns. Any number of
-- named price tiers per campaign (Adult/Child, a single Ticket tier, etc).
-- ---------------------------------------------------------------------------
create table tiers (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index tiers_campaign_id_idx on tiers(campaign_id);

-- ---------------------------------------------------------------------------
-- Ticket blocks: a campaign has one or more blocks, each Physical or Digital.
-- Physical blocks declare a pre-printed numeric range (tickets pre-populated below).
-- Digital blocks have no range — numbers are assigned at the moment of sale via
-- next_digital_number, and there's nothing to pre-populate.
-- ---------------------------------------------------------------------------
create table ticket_blocks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  type text not null check (type in ('physical', 'digital')),
  label text not null default 'Main',
  range_start int,
  range_end int,
  next_digital_number int not null default 1,
  created_at timestamptz not null default now(),
  constraint physical_needs_range check (
    (type = 'physical' and range_start is not null and range_end is not null and range_end >= range_start) or
    (type = 'digital' and range_start is null and range_end is null)
  )
);
create index ticket_blocks_campaign_id_idx on ticket_blocks(campaign_id);

-- ---------------------------------------------------------------------------
-- Tickets. tier_id replaces the old hardcoded ticket_type 'A'/'C' enum.
-- Physical tickets are pre-populated per block (one row per number, status 'unsold').
-- Digital tickets are created at sale time only (no 'unsold' backlog to pre-generate).
-- ---------------------------------------------------------------------------
create table tickets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  block_id uuid not null references ticket_blocks(id),
  ticket_number int not null,
  tier_id uuid references tiers(id),
  status text not null default 'unsold' check (status in ('unsold', 'cash_pending', 'held', 'paid')),
  payment_id uuid,
  sold_by uuid references users(id),
  sold_at timestamptz,
  attendee_name text,
  created_at timestamptz not null default now(),
  unique (block_id, ticket_number)
);
create index tickets_campaign_id_idx on tickets(campaign_id);
create index tickets_payment_id_idx on tickets(payment_id);
create index tickets_status_idx on tickets(status);

-- ---------------------------------------------------------------------------
-- Payments. Denomination/tier breakdown now comes from joining tickets -> tiers
-- instead of a redundant ticket_numbers array + hardcoded ticket_type grouping.
-- ---------------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  method text not null check (method in ('cash', 'card', 'card_manual')),
  amount numeric(10,2) not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'void')),
  seller_id uuid not null references users(id),
  payer_name text,
  sold_at timestamptz not null default now(),

  sumup_checkout_id text,
  sumup_checkout_ref text,
  sumup_transaction_code text,
  sumup_transaction_id text,
  resend_count int not null default 0,

  cash_confirmed_by uuid references users(id),
  cash_confirmed_at timestamptz,
  cash_recon_batch_id uuid,

  voided boolean not null default false,
  voided_by uuid references users(id),
  voided_at timestamptz,
  void_reason text,

  photo_path text,
  created_at timestamptz not null default now()
);
create index payments_campaign_id_idx on payments(campaign_id);
create index payments_seller_id_idx on payments(seller_id);
create index payments_status_idx on payments(status);

alter table tickets add constraint tickets_payment_id_fkey foreign key (payment_id) references payments(id);

-- ---------------------------------------------------------------------------
-- Cash reconciliation batches: oldest-first lump-sum matching against a seller's
-- pending cash payments, per campaign.
-- ---------------------------------------------------------------------------
create table cash_recon (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references users(id),
  campaign_id uuid not null references campaigns(id),
  amount_received numeric(10,2) not null,
  confirmed_by uuid not null references users(id),
  fully_matched boolean not null default false,
  surplus_amount numeric(10,2) not null default 0,
  shortfall_amount numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table payments add constraint payments_cash_recon_batch_id_fkey foreign key (cash_recon_batch_id) references cash_recon(id);

-- ---------------------------------------------------------------------------
-- Storage: private bucket for optional manual-card-payment photo evidence.
-- Viewing always goes through a short-lived signed URL, never a public link.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('payment-evidence', 'payment-evidence', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS: every table is served exclusively through the Netlify function using the
-- service-role key (which bypasses RLS) — the browser never talks to Supabase
-- directly with the anon key. Enabling RLS with no policies means the anon/
-- authenticated PostgREST roles get zero access by default, as defense in depth.
-- ---------------------------------------------------------------------------
alter table organizations enable row level security;
alter table users enable row level security;
alter table campaigns enable row level security;
alter table user_campaigns enable row level security;
alter table tiers enable row level security;
alter table ticket_blocks enable row level security;
alter table tickets enable row level security;
alter table payments enable row level security;
alter table cash_recon enable row level security;
