-- The Repository: the weekly SumUp sync, small product pictures, and "featured" items.
-- Additive only, and safe to run more than once: new columns on two of the Repository's own tables, one index, one public storage bucket.
--   * repository_items gets SumUp's permanent ids (so a weekly export updates the same item, not a copy), the barcode, where the picture came
--     from (image_src) and the small picture we made from it (image_path, in the 'repository' bucket), "featured", and when it was first added.
--   * repository_settings remembers when the stock was last brought up to date from SumUp.
--   * The 'repository' storage bucket holds only the small compressed pictures (WebP or JPEG, 100 KB at most each). It is public to read, like any
--     product picture on a shop page; only the server (service role) can put files in it.
alter table repository_items
  add column if not exists sumup_item_id text check (sumup_item_id is null or char_length(sumup_item_id) <= 80),
  add column if not exists sumup_variant_id text check (sumup_variant_id is null or char_length(sumup_variant_id) <= 80),
  add column if not exists barcode text check (barcode is null or char_length(barcode) <= 60),
  add column if not exists image_src text check (image_src is null or char_length(image_src) <= 300),
  add column if not exists image_path text check (image_path is null or char_length(image_path) <= 200),
  add column if not exists image_done_src text check (image_done_src is null or char_length(image_done_src) <= 300),
  add column if not exists featured boolean not null default false,
  add column if not exists added_at timestamptz not null default now(),
  add column if not exists seen_at timestamptz;
create unique index if not exists repository_items_variant_idx on repository_items (org_id, sumup_variant_id) where sumup_variant_id is not null;

alter table repository_settings
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_sync_note text check (last_sync_note is null or char_length(last_sync_note) <= 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('repository', 'repository', true, 102400, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;
