-- Parish Gateway, Phase 1: one public page per organisation at /go/<slug>.
-- Additive only, and safe to run more than once: nothing existing is dropped, renamed, or given a different meaning.
--   * organizations gets 4 new nullable-or-defaulted columns; campaigns gets 2.
--   * 4 new tables. None holds personal data, so the nightly retention job (retention_run) deliberately ignores them.
--   * the page is OFF for every organisation (gateway_enabled = false) and no campaign is listed (listed_on_gateway = false)
--     until a SuperAdmin switches them on.
-- Like every table here, they have row level security on and no policies: only the server (service role) reads or writes them.

-- ---------- Organisation: address of the page, on/off, time zone, name shown on the page ----------
alter table organizations
  add column if not exists slug text check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),   -- /go/<slug>; 3 to 40 lowercase letters, digits, hyphens
  add column if not exists gateway_enabled boolean not null default false,
  add column if not exists timezone text not null default 'Europe/London',   -- "today" and every opening/closing time on the page use this
  add column if not exists display_name text check (display_name is null or char_length(display_name) between 1 and 80),   -- masthead name; falls back to name
  add column if not exists gateway_phone text check (gateway_phone is null or char_length(gateway_phone) <= 40),   -- shown in "Parish office" on the page
  add column if not exists gateway_hours text check (gateway_hours is null or char_length(gateway_hours) <= 120);   -- e.g. "Tue–Fri, 10:00 am – 1:00 pm"
create unique index if not exists organizations_slug_idx on organizations (lower(slug)) where slug is not null;

-- ---------- Campaigns: opt in to the page (never listed by default) ----------
alter table campaigns
  add column if not exists listed_on_gateway boolean not null default false,
  add column if not exists gateway_cta text check (gateway_cta is null or char_length(gateway_cta) <= 24);   -- optional button words

-- ---------- The three permanent links ----------
create table if not exists gateway_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  position int not null check (position between 1 and 3),
  label text not null check (char_length(label) between 1 and 60),
  sub text not null default '' check (char_length(sub) <= 60),
  url text not null check (char_length(url) <= 2000 and url ~ '^https://'),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (org_id, position)
);

-- ---------- Announcement (every one is kept; the newest live one wins) ----------
create table if not exists gateway_announcements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 200),
  link_url text check (link_url is null or (char_length(link_url) <= 2000 and link_url ~ '^https://')),
  urgent boolean not null default false,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists gateway_announcements_org_idx on gateway_announcements (org_id, starts_at desc);

-- ---------- Items added by hand (not from Campaigns) ----------
create table if not exists gateway_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in ('involved', 'registration')),
  label text not null check (char_length(label) between 1 and 60),
  url text not null check (char_length(url) <= 2000 and url ~ '^https://'),
  cta text check (cta is null or char_length(cta) <= 24),
  starts_on date not null,
  ends_on date not null,   -- required: every item comes down by itself
  listed boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index if not exists gateway_items_org_idx on gateway_items (org_id);

-- ---------- Custom order per section; no row = automatic order (closing soonest) ----------
create table if not exists gateway_order (
  org_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in ('involved', 'registration')),
  item_ids text[] not null,   -- campaign ids or gateway_items ids, in order
  updated_at timestamptz not null default now(),
  primary key (org_id, section)
);

alter table gateway_links enable row level security;
alter table gateway_announcements enable row level security;
alter table gateway_items enable row level security;
alter table gateway_order enable row level security;
-- no policies, on purpose (see top).

-- Supabase stops granting new tables to its API roles automatically from 30 Oct 2026, and the server needs the service role
-- to reach them. Nothing is granted to anon or authenticated: the browser never talks to the database directly.
grant select, insert, update, delete on table gateway_links, gateway_announcements, gateway_items, gateway_order to service_role;

-- ---------- Seed: St. Vincent De Paul gets its address (the page stays OFF; the three links are entered by hand in the app) ----------
update organizations set slug = 'svp-osterley'
 where slug is null and name = 'St.Vincent De Paul Church, Osterley'
   and not exists (select 1 from organizations o2 where lower(o2.slug) = 'svp-osterley');
