-- Atomically reserves a run of `p_count` sequential ticket numbers off a digital block's own
-- counter and returns the first number in that run. The UPDATE...RETURNING is a single
-- statement, so Postgres's row lock on the ticket_blocks row serializes concurrent callers —
-- two simultaneous digital sales against the same block can never be handed the same number.
create or replace function reserve_digital_tickets(p_block_id uuid, p_count int)
returns int
language plpgsql
as $$
declare
  v_start int;
begin
  update ticket_blocks
  set next_digital_number = next_digital_number + p_count
  where id = p_block_id and type = 'digital'
  returning next_digital_number - p_count into v_start;

  if v_start is null then
    raise exception 'Digital block % not found (or not a digital block)', p_block_id;
  end if;

  return v_start;
end;
$$;
