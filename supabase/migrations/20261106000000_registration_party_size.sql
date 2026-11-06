-- Registrations 2, part 1: one registration can take several places (a person and their companion), and the places count is kept by the
-- database. Also closes off two ticket-claiming functions that the public database roles could run (only our server needs them).
-- Additive for the data: one new column with a default of 1, so every existing registration still takes exactly one place.

alter table registrations add column if not exists party_size integer not null default 1 check (party_size between 1 and 20);

-- Places in use for a form: the sum of the party sizes of everything that holds a place (declined and cancelled give theirs back).
create or replace function public.registration_used(p_campaign uuid)
returns integer language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(party_size), 0)::int from registrations
   where campaign_id = p_campaign and status in ('awaiting_payment', 'submitted', 'accepted')
$$;

-- register_claim now takes the party size. The old ten-argument version is dropped, because two versions would be ambiguous; the new one
-- has p_party defaulting to 1, so the code that is live today (which does not send it) keeps working unchanged.
drop function if exists public.register_claim(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text);
create or replace function public.register_claim(p_campaign uuid, p_name text, p_phone text, p_email text, p_answers jsonb, p_agreements jsonb, p_status text, p_payment uuid, p_ip text, p_client_ref text, p_party integer default 1)
returns table(reg_id uuid, number integer) language plpgsql security definer set search_path to 'public' as $$
declare v_places integer; v_next integer; v_used integer; v_id uuid; v_party integer := greatest(1, coalesce(p_party, 1));
begin
  select places into v_places from campaigns where id = p_campaign for update;
  if not found then raise exception 'NO_CAMPAIGN'; end if;
  select coalesce(max(r.reg_number), 0) + 1, coalesce(sum(r.party_size) filter (where r.status not in ('cancelled', 'declined')), 0)
    into v_next, v_used from registrations r where r.campaign_id = p_campaign;
  if v_places is not null and v_used >= v_places then raise exception 'FULL'; end if;
  if v_places is not null and v_used + v_party > v_places then raise exception 'TOO_MANY:%', v_places - v_used; end if;
  insert into registrations (campaign_id, reg_number, name, phone, email, answers, agreements, status, payment_id, client_ip, client_ref, party_size)
  values (p_campaign, v_next, p_name, p_phone, p_email, p_answers, p_agreements, p_status, p_payment, p_ip, p_client_ref, v_party)
  returning id into v_id;
  return query select v_id, v_next;
end $$;

-- Only the server (service role) may run these. New functions get no automatic grants any more, so this is stated explicitly.
revoke all on function public.registration_used(uuid) from public, anon, authenticated;
grant execute on function public.registration_used(uuid) to service_role;
revoke all on function public.register_claim(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.register_claim(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text, integer) to service_role;
revoke execute on function public.claim_lowest_available_tickets(uuid, uuid[], text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.claim_specific_tickets(uuid, jsonb, text, uuid, uuid) from public, anon, authenticated;
