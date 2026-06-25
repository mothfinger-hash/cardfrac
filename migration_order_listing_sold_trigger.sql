-- migration_order_listing_sold_trigger.sql
--
-- Durable marketplace consistency: when a marketplace order is created (or
-- moves to a paid/shipped/completed status), mark its linked listing 'sold'
-- in the SAME transaction — independent of the Vercel Stripe webhook.
--
-- Why: the webhook is the normal path that marks listings sold, but if it
-- ever fails to fire or errors (as happened during the 405 window, and the
-- earlier sold_to-column bug), a paid listing could stay live in the
-- marketplace. This database trigger guarantees it can't.
--
-- Safe + idempotent: only flips listings that are still active/available, so
-- re-running or double-firing is a no-op. Buyer is already tracked on the
-- order (orders.buyer_id); the trigger only touches listings.status.

CREATE OR REPLACE FUNCTION public.mark_listing_sold_on_order()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.listing_id IS NOT NULL
     AND NEW.status IN ('paid','shipped','completed') THEN
    UPDATE public.listings
      SET status = 'sold'
      WHERE id = NEW.listing_id
        AND status IN ('active','available');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mark_listing_sold ON public.orders;
CREATE TRIGGER trg_mark_listing_sold
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_listing_sold_on_order();

-- One-time reconcile for anything already stranded (paid order, live listing).
UPDATE public.listings l
  SET status = 'sold'
  FROM public.orders o
  WHERE o.listing_id = l.id
    AND o.status IN ('paid','shipped','completed')
    AND l.status IN ('active','available');
