-- When an Admin presses "Sorted" on a paid-but-no-tickets payment, the note is kept as the record of what happened, and this says
-- who dealt with it and when. Additive: two nullable columns.
alter table payments add column if not exists attention_done_at timestamptz;
alter table payments add column if not exists attention_done_by uuid references users(id);
