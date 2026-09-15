-- Atomically claims a set of physical tickets for one sale. All-or-nothing: if ANY
-- requested ticket isn't currently 'unsold', the raised exception rolls back every
-- update in this call (Postgres rolls back the whole function on an unhandled
-- exception) — replaces the old app-level loop-with-manual-rollback, which could
-- leave a half-claimed sale behind if the process crashed mid-loop.
create or replace function claim_physical_tickets(
  p_block_id uuid,
  p_items jsonb, -- [{"ticket_number": 30001, "tier_id": "<uuid>"}, ...]
  p_status text,
  p_payment_id uuid,
  p_sold_by uuid
) returns void
language plpgsql
as $$
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
    where t.block_id = p_block_id
      and t.ticket_number = items.ticket_number
      and t.status = 'unsold'
    returning t.ticket_number
  )
  select count(*) into v_updated from upd;

  if v_updated <> v_expected then
    raise exception 'CLAIM_FAILED: expected % ticket(s), claimed %', v_expected, v_updated;
  end if;
end;
$$;
