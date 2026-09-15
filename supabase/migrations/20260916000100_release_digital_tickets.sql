-- Reverses reserve_digital_tickets: used only by a same-seller, same-window Undo (never a
-- general refund/void path) so a corrected resubmission reuses the same numbers instead of
-- skipping ahead and leaving a gap. Clamped at 1 so a bug elsewhere can't push it negative.
create or replace function release_digital_tickets(p_block_id uuid, p_count int)
returns void
language plpgsql
as $$
begin
  update ticket_blocks
  set next_digital_number = greatest(1, next_digital_number - p_count)
  where id = p_block_id and type = 'digital';
end;
$$;
