-- Fixes a real bug before this ever ran for real: a campaign can have more than one
-- physical block (e.g. a Main range plus a later TOPUP range), and the ticket NUMBER
-- itself — not a pre-chosen block — determines which one it belongs to. The previous
-- version required the caller to pick a single block_id up front, so a ticket that
-- actually belonged to the campaign's second physical block would wrongly fail as
-- unavailable. Same all-or-nothing atomicity as before, just scoped by campaign
-- instead of by a single block, and restricted to physical-type blocks so a numeral
-- that happens to coincide with a digital block's own numbering can't be claimed here.
drop function if exists claim_physical_tickets(uuid, jsonb, text, uuid, uuid);

create function claim_physical_tickets(
  p_campaign_id uuid,
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
    join ticket_blocks tb on tb.id = t.block_id
    where t.campaign_id = p_campaign_id
      and tb.type = 'physical'
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
