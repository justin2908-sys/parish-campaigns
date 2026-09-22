-- Fixes a real bug found while testing the first real sale: PostgreSQL does not allow
-- referencing the UPDATE target table (t) inside a JOIN...ON clause within the FROM list
-- ("invalid reference to FROM-clause entry for table t") — every physical sale has been
-- failing on this since 20260916000300 added campaign-scoping. The target table CAN be
-- referenced in WHERE and in a correlated subquery, so the physical-block check moves there.
create or replace function claim_physical_tickets(
  p_campaign_id uuid,
  p_items jsonb,
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
    where t.campaign_id = p_campaign_id
      and t.ticket_number = items.ticket_number
      and t.status = 'unsold'
      and exists (select 1 from ticket_blocks tb where tb.id = t.block_id and tb.type = 'physical')
    returning t.ticket_number
  )
  select count(*) into v_updated from upd;

  if v_updated <> v_expected then
    raise exception 'CLAIM_FAILED: expected % ticket(s), claimed %', v_expected, v_updated;
  end if;
end;
$$;

alter function claim_physical_tickets(uuid, jsonb, text, uuid, uuid) set search_path = public;
