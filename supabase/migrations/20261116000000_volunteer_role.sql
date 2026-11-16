-- A new kind of user: the Volunteer (helps with the parish page, Repository orders, Listings approval and Light a Candle, but never
-- creates or changes campaigns or touches money). A Volunteer can also be a seller: "also_sells" gives them the Seller selling screen.
-- Additive only: one new column, and the allowed-roles list gains one word.
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role = any (array['platform_owner','superadmin','admin','seller','finance','priest','volunteer']::text[]));

alter table public.users add column if not exists also_sells boolean not null default false;
