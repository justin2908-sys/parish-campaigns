-- A client-generated reference per sale attempt, so a retry after a lost reply (weak signal)
-- returns the original sale instead of creating a second one. Unique across all payments;
-- null for older rows and for any caller that doesn't send one.
alter table payments add column client_ref text;
create unique index payments_client_ref_key on payments (client_ref) where client_ref is not null;
