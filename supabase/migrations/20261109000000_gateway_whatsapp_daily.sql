-- Parish Gateway: a WhatsApp channel link at the top of the page, and the "Today in the Church" card (feast of the day + Mass readings).
-- Additive only, and safe to run more than once: two new columns on organizations, nothing else touched.
--   * gateway_whatsapp: the parish's WhatsApp channel link (https://whatsapp.com/channel/...). Empty = no button on the page.
--   * gateway_daily: show today's feast and readings on the page. On by default; the page itself is still off until a SuperAdmin switches it on.
-- The new columns are plain settings (no personal data). Access stays as before: RLS on, only the server (service role) reads or writes.
alter table organizations
  add column if not exists gateway_whatsapp text check (gateway_whatsapp is null or char_length(gateway_whatsapp) <= 200),
  add column if not exists gateway_daily boolean not null default true;
