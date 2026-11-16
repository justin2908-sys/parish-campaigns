-- Refunds can never exceed what was paid, enforced in the database itself (not just in the app), whoever or whatever writes to it.
--  * a refund must be more than 0 and no more than the payment amount;
--  * a refund can only be written onto a payment that is actually 'paid';
--  * once refunded, the payment's amount cannot be lowered below the refund (voiding a refunded sale stays allowed).
-- Additive only: one function and one trigger. Existing data checked first: no refunds on record, so nothing can clash.
create or replace function public.payments_refund_cap() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.refund_amount is not null then
    if new.refund_amount <= 0 then
      raise exception 'A refund must be more than 0.' using errcode = '23514';
    end if;
    if new.refund_amount > new.amount then
      raise exception 'A refund (%) cannot be more than the amount paid (%).', new.refund_amount, new.amount using errcode = '23514';
    end if;
    -- "must be paid" applies when a refund is being written (new, or changed); later changes to the sale (e.g. voiding it) stay allowed.
    if new.status <> 'paid' and (tg_op = 'INSERT' or new.refund_amount is distinct from old.refund_amount) then
      raise exception 'Only a payment that has been received can be refunded.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists payments_refund_cap on public.payments;
create trigger payments_refund_cap
  before insert or update on public.payments
  for each row execute function public.payments_refund_cap();

revoke all on function public.payments_refund_cap() from public, anon, authenticated;
grant execute on function public.payments_refund_cap() to service_role;
