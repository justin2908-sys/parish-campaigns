-- Make a Donation: a parishioner gives any amount (from GBP 1 up to GBP 5,000, GBP 10 suggested) by card on a page of their own, /donate/<address>.
-- Additive only, and safe to run more than once: three new tables and one function. Nothing existing is changed.
--   * donation_settings  per organisation: on/off, a welcome line, and the next donation number
--   * donations          one row per donation: reference (DON-001), amount, status. The giver's name and contact (both optional) stay on the payment only,
--                        never here, so the normal retention job clears them
--   * donation_months    one hidden campaign per month, so each donation's payment sits in the normal payments ledger (refunds, the SumUp check,
--                        Needs Attention) and its personal details are cleared by the normal retention job
-- Like every table here: row level security on, no policies; only the server (service role) reads or writes. Explicit grants, as required.

create table if not exists donation_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default false,
  intro_text text check (intro_text is null or char_length(intro_text) <= 300),
  next_ref integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ref_no integer not null,
  payment_id uuid references payments(id) on delete set null,
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'cancelled')),
  amount numeric(10,2) not null check (amount >= 1 and amount <= 5000),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  client_ref text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz,
  unique (org_id, ref_no)
);
create unique index if not exists donations_client_ref_idx on donations (org_id, client_ref) where client_ref is not null;
create index if not exists donations_created_idx on donations (org_id, created_at);
create index if not exists donations_payment_idx on donations (payment_id);

create table if not exists donation_months (
  org_id uuid not null references organizations(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  primary key (org_id, month)
);

alter table donation_settings enable row level security;
alter table donations enable row level security;
alter table donation_months enable row level security;
grant select, insert, update, delete on table donation_settings, donations, donation_months to service_role;

-- The next donation number for an organisation, taken in one step (two donations at the same moment never get the same number).
create or replace function public.donation_next_ref(p_org uuid)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_ref integer;
begin
  insert into donation_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  update donation_settings set next_ref = next_ref + 1 where org_id = p_org returning next_ref - 1 into v_ref;
  return v_ref;
end $$;
revoke all on function public.donation_next_ref(uuid) from public, anon, authenticated;
grant execute on function public.donation_next_ref(uuid) to service_role;
