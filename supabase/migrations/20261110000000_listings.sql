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
