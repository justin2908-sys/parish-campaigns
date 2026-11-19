-- Make a Donation: an optional "what is your gift for?" (Altar Flowers, Church Building Fund, ...). The office keeps a short list of suggested purposes that
-- the donation page offers as tap-to-fill choices; the giver can also write their own. Stored on the donation (it is a fund name, not personal data).
alter table donation_settings add column if not exists purposes jsonb not null default '[]'::jsonb;
alter table donations add column if not exists purpose text check (purpose is null or char_length(purpose) <= 100);
