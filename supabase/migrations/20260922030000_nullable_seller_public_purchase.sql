-- A buyer-direct purchase (no seller involved) is a real, intentional case, not an error —
-- record it as seller_id = null rather than forcing every sale through a person.
alter table payments alter column seller_id drop not null;
