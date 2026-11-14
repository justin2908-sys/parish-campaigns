-- An optional one-line tagline shown under the campaign's name on its public page (e.g. "Buffet Dinner & Family Entertainment").
-- Run order: after 20261112000000_hearts.sql
alter table campaigns add column if not exists tagline text check (tagline is null or char_length(tagline) <= 50);
