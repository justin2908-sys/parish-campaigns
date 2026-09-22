-- Online (digital) tickets move from an open-ended auto-incrementing counter to a properly
-- defined, range-based series — exactly like physical — per Justin: "Online tickets will
-- come from a series which I will configure e.g. O15001 to O20000." This also unlocks
-- "lucky number" selection for online tickets (pick and check a specific number), which was
-- impossible under the old counter-only model since nothing existed to check against.
--
-- Physical and digital blocks are now structurally identical: both pre-populate real
-- 'unsold' ticket rows across a declared range. The only remaining differences are (a) the
-- payment-method restriction (digital = Pay by Link only, enforced in application code) and
-- (b) an optional display prefix, e.g. "O", shown before the raw number to buyers — this is
-- not an invented physical-reality mismatch (non-negotiable #8): for a ticket with no
-- separate physical object, whatever number we tell the buyer IS what they're "holding".

alter table ticket_blocks drop constraint if exists physical_needs_range;
alter table ticket_blocks add constraint blocks_need_range check (range_start is not null and range_end is not null and range_end >= range_start);

alter table ticket_blocks add column number_prefix text not null default '';

-- No longer needed: digital blocks now pre-populate real rows and are claimed the same way
-- as physical (either a specific number or the lowest available), not minted on the fly.
alter table ticket_blocks drop column next_digital_number;
drop function if exists reserve_digital_tickets(uuid, int);
drop function if exists release_digital_tickets(uuid, int);

-- Renamed from claim_physical_tickets: it's no longer physical-specific now that digital
-- blocks also pre-populate real rows. Behavior unchanged — atomic, all-or-nothing, resolved
-- by campaign + ticket number (a campaign can have more than one block of a given type, e.g.
-- a physical top-up or a second online series, and the number itself picks the right one).
drop function if exists claim_physical_tickets(uuid, jsonb, text, uuid, uuid);
create function claim_specific_tickets(
  p_campaign_id uuid,
  p_items jsonb, -- [{"ticket_number": 15221, "tier_id": "<uuid>"}, ...]
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
    returning t.ticket_number
  )
  select count(*) into v_updated from upd;

  if v_updated <> v_expected then
    raise exception 'CLAIM_FAILED: expected % ticket(s), claimed %', v_expected, v_updated;
  end if;
end;
$$;
alter function claim_specific_tickets(uuid, jsonb, text, uuid, uuid) set search_path = public;

-- New: for a buyer/seller who doesn't care which number, atomically claims the N lowest
-- ticket numbers still unsold in one specific block. FOR UPDATE SKIP LOCKED means two
-- concurrent "any available" purchases against the same series can never collide.
create function claim_lowest_available_tickets(
  p_block_id uuid,
  p_tier_ids uuid[], -- one tier id per ticket wanted, in the order tiers should be assigned
  p_status text,
  p_payment_id uuid,
  p_sold_by uuid
) returns table(ticket_number int)
language plpgsql
as $$
declare
  v_count int := coalesce(array_length(p_tier_ids, 1), 0);
  v_ids uuid[];
begin
  if v_count = 0 then
    raise exception 'CLAIM_FAILED: nothing requested';
  end if;

  -- RETURNS TABLE(ticket_number int) creates an implicit variable named ticket_number in
  -- this function's scope, which collides with the real column of the same name unless
  -- every reference to it here is qualified (tickets.ticket_number / t.ticket_number) or
  -- aliased (tn) — an unqualified "ticket_number" below is ambiguous and fails to compile.
  select array_agg(id order by tn) into v_ids
  from (
    select id, tickets.ticket_number as tn from tickets
    where block_id = p_block_id and status = 'unsold'
    order by tn
    limit v_count
    for update skip locked
  ) sub;

  if v_ids is null or array_length(v_ids, 1) <> v_count then
    raise exception 'CLAIM_FAILED: only % of % requested ticket(s) available', coalesce(array_length(v_ids, 1), 0), v_count;
  end if;

  return query
  update tickets t
  set tier_id = x.tier_id,
      status = p_status,
      payment_id = p_payment_id,
      sold_by = p_sold_by,
      sold_at = now()
  from (select unnest(v_ids) as id, unnest(p_tier_ids) as tier_id) x
  where t.id = x.id
  returning t.ticket_number;
end;
$$;
alter function claim_lowest_available_tickets(uuid, uuid[], text, uuid, uuid) set search_path = public;
