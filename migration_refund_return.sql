-- migration_refund_return.sql
--
-- Refund + return flow end-to-end.
--
-- Pre-this-migration:
--   - Buyer could click "Report Issue" which flipped order.status to
--     return_requested with no structured reason text.
--   - Sellers had NO UI to respond to a return — only admin could refund.
--   - No record of when/how the dispute resolved.
--
-- This migration adds the structured fields the new flow needs. The
-- order lifecycle remains the same shape from CLAUDE.md:
--   paid → shipped → completed
--   paid|shipped → return_requested → refunded | disputed → refunded|completed
--
-- Columns added (all nullable, idempotent):
--   return_reason          enum-y text: 'not_as_described' | 'damaged'
--                          | 'never_arrived' | 'wrong_item' | 'other'
--   return_reason_detail   free-text from the buyer
--   return_requested_at    timestamp the buyer clicked Report Issue
--   return_decided_at      timestamp the seller approved or declined
--   return_decision        'approved' | 'declined' | null
--   disputed_at            timestamp set when status flipped to disputed
--                          (seller declined OR escalated by admin)
--   refunded_application_fee boolean tracking whether the application fee
--                            was also reversed on a destination charge.
--                            Defaults false; set true by /api/seller-refund
--                            and /api/refund-order when reverse_transfer +
--                            refund_application_fee are sent to Stripe.

alter table public.orders
  add column if not exists return_reason            text,
  add column if not exists return_reason_detail     text,
  add column if not exists return_requested_at      timestamptz,
  add column if not exists return_decided_at        timestamptz,
  add column if not exists return_decision          text,
  add column if not exists disputed_at              timestamptz,
  add column if not exists refunded_application_fee boolean not null default false;

-- Tightly-scoped check on return_decision so a typo can't sneak in via
-- a direct DB write. NULL is allowed (no decision yet).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_return_decision_chk'
  ) then
    alter table public.orders
      add constraint orders_return_decision_chk
      check (return_decision is null or return_decision in ('approved', 'declined'));
  end if;
end $$;

-- Same for return_reason — the client sends one of these values.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_return_reason_chk'
  ) then
    alter table public.orders
      add constraint orders_return_reason_chk
      check (return_reason is null or return_reason in (
        'not_as_described', 'damaged', 'never_arrived', 'wrong_item', 'other'
      ));
  end if;
end $$;

-- Index supporting the "show me my pending return requests" query the
-- seller dashboard runs. Partial index keeps it cheap on a wide table.
create index if not exists orders_return_requested_idx
  on public.orders (seller_id, return_requested_at)
  where status = 'return_requested';

comment on column public.orders.return_reason is
  'Enum of buyer-supplied return reasons: not_as_described, damaged, never_arrived, wrong_item, other.';
comment on column public.orders.return_reason_detail is
  'Free-text explanation the buyer added when filing the return.';
comment on column public.orders.refunded_application_fee is
  'True if the platform-side application fee was reversed alongside the refund. Destination charges only.';
