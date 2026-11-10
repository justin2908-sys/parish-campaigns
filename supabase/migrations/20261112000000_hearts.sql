-- Hearts: a visitor can heart a listing or a Repository item (no sign-in, one heart per visitor per thing, and they can take it back).
--   * hearts            who hearted what, as a scrambled address (never a readable one); cleared after 180 days
--   * listings.hearts / repository_items.hearts   the running count, shown on the page and used as one modest input to the ordering
-- Run order: after 20261111000000_candles_digest.sql

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
