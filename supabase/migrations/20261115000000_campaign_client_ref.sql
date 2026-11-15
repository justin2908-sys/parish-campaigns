-- A reference the office's browser attaches to each "create campaign" sitting, so a double tap or a retry on a weak signal
-- makes ONE campaign, not two. Unique per parish; campaigns made before this have none.
-- Run order: after 20261114000000_campaign_tagline.sql
alter table campaigns add column if not exists client_ref text;
create unique index if not exists campaigns_client_ref_idx on campaigns (org_id, client_ref) where client_ref is not null;
