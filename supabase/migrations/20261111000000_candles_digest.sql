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
