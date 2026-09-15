-- Pins search_path on every SECURITY-relevant function this build added. Without it, a
-- function that references unqualified table names (tickets, ticket_blocks, ...) resolves
-- them via the caller's search_path — which an attacker able to create same-named objects
-- earlier in that path could hijack. Fixing it to 'public' closes that off.
alter function reserve_digital_tickets(uuid, int) set search_path = public;
alter function release_digital_tickets(uuid, int) set search_path = public;
alter function claim_physical_tickets(uuid, jsonb, text, uuid, uuid) set search_path = public;
