-- Attempt counters for lockouts and abuse limits (login, public purchases, public reads).
-- One row per key; the window restarts once it has expired. Only the server (service role) uses it.
create table rate_limits (
  key text primary key,
  hits int not null default 0,
  window_start timestamptz not null default now()
);
alter table rate_limits enable row level security;

create or replace function rate_hit(p_key text, p_window_seconds int) returns int
language plpgsql set search_path = public as $$
declare v_hits int;
begin
  insert into rate_limits as r (key, hits, window_start) values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning r.hits into v_hits;
  return v_hits;
end $$;

create or replace function rate_peek(p_key text, p_window_seconds int) returns int
language sql stable set search_path = public as $$
  select coalesce((select r.hits from rate_limits r where r.key = p_key and r.window_start >= now() - make_interval(secs => p_window_seconds)), 0)
$$;

create or replace function rate_reset(p_key text) returns void
language sql set search_path = public as $$ delete from rate_limits where key = p_key $$;

create or replace function rate_prune() returns void
language sql set search_path = public as $$ delete from rate_limits where window_start < now() - interval '2 days' $$;

revoke execute on function rate_hit(text, int), rate_peek(text, int), rate_reset(text), rate_prune() from public, anon, authenticated;

-- Where a public (buyer-direct) purchase came from, so one visitor can't hold a whole series.
alter table payments add column client_ip text;
create index payments_client_ip_pending_idx on payments (client_ip) where client_ip is not null and status = 'pending';
