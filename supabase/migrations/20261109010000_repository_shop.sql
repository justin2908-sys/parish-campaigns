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
