-- One reusable payment link per Organization (non-negotiable #5: a single reusable/dynamic
-- SumUp Payment Link works fine, no per-sale API call needed). The original app only ever
-- had a pre-baked static QR image asset with no link text behind it, which made "share this
-- link by SMS/WhatsApp/Email" impossible to build for real — this gives the Sell screen an
-- actual URL to build a QR from and to share.
alter table organizations add column payment_link_url text;
