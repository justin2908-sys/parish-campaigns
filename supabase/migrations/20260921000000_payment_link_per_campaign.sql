-- Payment links / QR codes are specific to each campaign, not one per parish (corrects
-- 20260916000200_org_payment_link.sql). No data existed in the org column yet.
alter table campaigns add column payment_link_url text;
alter table organizations drop column payment_link_url;
