# The database baseline

`live-schema-2026-10-27.sql` is the complete structure of the live database as it stood on 2026-10-27: tables, keys, checks, indexes,
row-level security, functions and the permissions the server needs. It holds no data.

**Use it to build a new, empty database** (a staging copy, or a dedicated install for one customer): create a Supabase project, open the
SQL Editor, paste the file, run it once. It is not a migration for the live database and must not be run on a database that already has
these tables.

**It was checked against the live database.** The file's seven sections were compared byte for byte with what the live database itself
reports (same query, hashed). To check again, run this in the live project and compare each `hash` with the md5 of the matching
section of the file (text between its `-- === SECTION n` line and the next, with leading and trailing blank lines trimmed):

```sql
with t as (select c.oid, c.relname, c.relrowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'),
tables as (select 1 ord, relname n, 'create table public.'||quote_ident(relname)||E' (\n'||(select string_agg('  '||quote_ident(a.attname)||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' not null' else '' end||coalesce(' default '||pg_get_expr(d.adbin,d.adrelid),''), E',\n' order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped)||E'\n);' ddl from t),
cons1 as (select 2 ord, conrelid::regclass::text||conname n, 'alter table '||conrelid::regclass::text||' add constraint '||quote_ident(conname)||' '||pg_get_constraintdef(oid)||';' ddl from pg_constraint where connamespace='public'::regnamespace and contype in ('p','u','c')),
cons2 as (select 3 ord, conrelid::regclass::text||conname n, 'alter table '||conrelid::regclass::text||' add constraint '||quote_ident(conname)||' '||pg_get_constraintdef(oid)||';' ddl from pg_constraint where connamespace='public'::regnamespace and contype='f'),
idx as (select 4 ord, tablename||indexname n, indexdef||';' ddl from pg_indexes where schemaname='public' and indexname not in (select conname from pg_constraint where connamespace='public'::regnamespace)),
rls as (select 5 ord, relname n, 'alter table public.'||quote_ident(relname)||' enable row level security;' ddl from t where relrowsecurity),
fns as (select 6 ord, proname||oid::text n, pg_get_functiondef(oid)||';' ddl from pg_proc where pronamespace='public'::regnamespace),
grants as (select 7 ord, table_name n, 'grant '||string_agg(distinct privilege_type, ', ')||' on table public.'||quote_ident(table_name)||' to service_role;' ddl from information_schema.role_table_grants where table_schema='public' and grantee='service_role' group by table_name),
allp as (select * from tables union all select * from cons1 union all select * from cons2 union all select * from idx union all select * from rls union all select * from fns union all select * from grants)
select ord, count(*) pieces, md5(string_agg(ddl, E'\n\n' order by n)) hash from allp group by ord order by ord;
```

Hashes on 2026-11-09, after migration 20261109000000_gateway_whatsapp_daily (18 tables, 56 keys/checks, 38 links, 21 indexes, 18 row-security switches, 13 functions, 18 permission lines). On 2026-10-27 the file was first verified (sections 1, 2 and 6 were then 9010c5c8…, 9c3ed6ba…, 331e48c2…; the other four are unchanged):

| Section | Hash |
|---|---|
| 1 tables | 4d1a12c20fd7e131e10c450f02aa3ebd |
| 2 keys, unique rules, checks | b184ab3c1244cc834494486caa640d8d |
| 3 links between tables | c3fb2a2f1904bd849bdaa1616c3f0f01 |
| 4 indexes | dc2c58e79e4698245f8618ae73702a3f |
| 5 row level security | ada629ffd53b81268199e91b15a158e8 |
| 6 functions | 19561350ae6ac6a5e183c426743793b7 |
| 7 permissions | 14380e97ab3ace5fa5949a8744c03375 |

**The rule from now on:** the database is changed only by a numbered file in `supabase/migrations/`, saved in the repository first.
When a change is applied, this baseline is regenerated and the table above updated, so the repository is always a complete record.

**Not in the file:** the nightly deletion job is included (section 8), but the extensions must be allowed by the new project, and the unused
storage bucket `payment-evidence` is deliberately not recreated.

**2026-11-09, the Repository (parish shop):** migration `20261109010000_repository_shop` added five tables (`repository_items`, `repository_settings`, `repository_weekends`, `repository_orders`, `repository_order_lines`) and three functions (`shop_place_order`, `shop_cancel_order`, `shop_reinstate_order`). They are appended to the baseline file as **section 9** (and, for the weekly sync and pictures migration `20261109020000_repository_sync_images`, **section 10**, which also creates the public `repository` storage bucket) (the migration's own text), not merged into sections 1 to 7, so the seven hashes above still describe the database *without* the Repository objects. To check a copy built from this file, compare sections 1 to 7 after excluding anything named `repository_*` / `shop_*`. Building a new database from the file is unaffected: run it top to bottom, section 9 last.

**2026-11-10, Listings:** migration `20261110000000_listings` added five tables (`listings_settings`, `listings`, `listing_events`, `listing_reports`, `listing_months`), one function (`listing_event`) and the public `listings` storage bucket. They are appended to the baseline file as **section 11**; sections 1 to 7 still describe the database without the Repository and Listings objects.

**2026-11-11, Light a Candle and the Thursday email:** migration `20261111000000_candles_digest` added four tables (`candle_settings`, `candle_requests`, `candle_months`, `weekly_digest`) and one function (`candle_next_ref`). They are appended to the baseline file as **section 12**; sections 1 to 7 still describe the database without the Repository, Listings and Candles objects.

**2026-11-12, Hearts:** migration `20261112000000_hearts` added a `hearts` count to `listings` and `repository_items`, one table (`hearts`) and one function (`heart_set`). Appended to the baseline file as **section 13**.
