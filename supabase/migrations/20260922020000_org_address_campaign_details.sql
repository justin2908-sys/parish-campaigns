-- Two free-text fields, deliberately unstructured rather than a rigid "prizes" /
-- "draw_date" schema: every campaign type needs different things on its ticket (a raffle
-- has prizes and a draw date, a dinner has neither), so a SuperAdmin writes whatever's
-- relevant once per campaign, and it's reused verbatim in every ticket message for it.
-- The address belongs on the Organization, not the campaign, since every campaign from one
-- parish shares the same address.
alter table organizations add column address text;
alter table campaigns add column details_text text;
