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

Hashes on 2026-10-27 (18 tables, 54 keys/checks, 38 links, 21 indexes, 18 row-security switches, 12 functions, 18 permission lines):

| Section | Hash |
|---|---|
| 1 tables | 9010c5c8a785fd5e0da7b1dcdbebeaef |
| 2 keys, unique rules, checks | 9c3ed6ba42b2b42e0c241c6b3cdca907 |
| 3 links between tables | c3fb2a2f1904bd849bdaa1616c3f0f01 |
| 4 indexes | dc2c58e79e4698245f8618ae73702a3f |
| 5 row level security | ada629ffd53b81268199e91b15a158e8 |
| 6 functions | 331e48c2656c0d5e3f23dfe1bdd7e135 |
| 7 permissions | 14380e97ab3ace5fa5949a8744c03375 |

**The rule from now on:** the database is changed only by a numbered file in `supabase/migrations/`, saved in the repository first.
When a change is applied, this baseline is regenerated and the table above updated, so the repository is always a complete record.

**Not in the file:** the nightly deletion job is included (section 8), but the extensions must be allowed by the new project, and the unused
storage bucket `payment-evidence` is deliberately not recreated.
