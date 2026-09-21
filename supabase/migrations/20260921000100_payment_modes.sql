-- Payment modes, renamed to what sellers actually call them:
--   cash     (was cash)
--   machine  (was card_manual) — tapped on the POS machine outside the church, seller logs it
--   link     (was card)        — per-sale SumUp checkout link, sent to the buyer, auto-marked
--                                paid when SumUp notifies us
-- No real data exists yet, so this is a straight rename.
alter table payments drop constraint if exists payments_method_check;
update payments set method = case method when 'card' then 'link' when 'card_manual' then 'machine' else method end;
alter table payments add constraint payments_method_check check (method in ('cash', 'machine', 'link'));

-- For a Pay-by-Link sale we record WHO the link went to and how, so a handed-over physical
-- ticket can be tied to a specific person's mobile/email and its paid status pinpointed.
-- contact_value is personal data: it is anonymized with payer_name after the retention window.
alter table payments add column contact_value text;
alter table payments add column contact_channel text check (contact_channel in ('sms', 'whatsapp', 'email'));
alter table payments add column link_url text;
alter table payments add column link_shared_at timestamptz;

-- The fixed per-campaign payment link is superseded: every Pay-by-Link sale now gets its own
-- SumUp checkout with its own reference.
alter table campaigns drop column payment_link_url;
