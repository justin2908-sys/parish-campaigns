-- The money statement needs to know WHEN each payment was actually received (not when its link was made, which can be days earlier).
--  * payments.paid_at   the moment a payment became 'paid': set by the database itself the first time the status turns to 'paid'
--                       (card sale at the machine, online payment confirmed by SumUp, cash handed over and reconciled) - so every way
--                       of being paid is covered, whatever code writes it.
--  * existing paid payments are filled in from the best date we hold (cash: when it was confirmed; otherwise when it was sold or made).
-- Additive only: one column, two indexes, one function and one trigger. Nothing is removed or renamed.
alter table public.payments add column if not exists paid_at timestamptz;

update public.payments
   set paid_at = coalesce(cash_confirmed_at, sold_at, created_at)
 where status = 'paid' and paid_at is null;

create index if not exists payments_paid_at_idx on public.payments (paid_at) where paid_at is not null;
create index if not exists payments_refunded_at_idx on public.payments (refunded_at) where refunded_at is not null;

create or replace function public.payments_set_paid_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'paid' and new.paid_at is null and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    new.paid_at := now();
  end if;
  return new;
end $$;

drop trigger if exists payments_set_paid_at on public.payments;
create trigger payments_set_paid_at
  before insert or update on public.payments
  for each row execute function public.payments_set_paid_at();

revoke all on function public.payments_set_paid_at() from public, anon, authenticated;
grant execute on function public.payments_set_paid_at() to service_role;
