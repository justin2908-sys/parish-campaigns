-- Picks up to p_count random ONLINE ticket numbers that are still unsold, for the public buy
-- page's "shuffle" button. Suggestions only: nothing is reserved until the buyer pays, and the
-- all-or-nothing claim at purchase time is what actually guarantees a number.
create or replace function random_unsold_numbers(p_campaign_id uuid, p_block_id uuid, p_count int, p_exclude int[])
returns setof int
language sql
volatile
set search_path = public
as $$
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
$$;
revoke execute on function random_unsold_numbers(uuid, uuid, int, int[]) from public, anon, authenticated;
