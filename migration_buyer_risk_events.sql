-- ============================================================
-- PathBinder — Buyer risk events (friendly-fraud tracking)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- One row per noteworthy buyer event (chargeback, refund, abuse
-- claim, suspended account). Keyed primarily on the Stripe card
-- `fingerprint` (a stable cross-charge / cross-account identifier
-- for a single payment card) so a buyer cycling new accounts on the
-- same card still gets flagged. Also tagged with buyer_id, shipping
-- address hash, and order id so we can correlate.
--
-- Why fingerprint and not IP — IPs are dynamic, shared (CGNAT, café
-- wifi), and trivially evaded with a VPN. The card fingerprint is the
-- durable identity for marketplace fraud scoring.
--
-- Service-role-only writes (stripe-webhook + admin tooling). Anon
-- can't read — this is internal risk signal, not user-facing.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.buyer_risk_events (
  id                bigserial   PRIMARY KEY,
  card_fingerprint  text,                 -- nullable for non-card events
  buyer_id          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  order_id          uuid,                 -- listings.orders or stripe payment_intent id (text-coerced)
  stripe_charge_id  text,
  shipping_zip      text,                 -- coarse address signal, no PII detail
  event_type        text        NOT NULL,
                    -- 'chargeback_opened' | 'chargeback_lost' | 'chargeback_won'
                    -- | 'refund_full'     | 'refund_partial'  | 'abuse_claim'
                    -- | 'admin_flag'
  amount_cents      int         NOT NULL DEFAULT 0,
  reason            text,                 -- Stripe's dispute reason / our note
  notes             text,                 -- free-form admin notes
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.buyer_risk_events IS
  'Append-only fraud signal log keyed on Stripe card fingerprint. Powers the silent buyer risk score.';

-- Hot path: scoring a fingerprint at checkout time.
CREATE INDEX IF NOT EXISTS idx_buyer_risk_events_fingerprint
  ON public.buyer_risk_events (card_fingerprint, created_at DESC)
  WHERE card_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_buyer_risk_events_buyer
  ON public.buyer_risk_events (buyer_id, created_at DESC);

ALTER TABLE public.buyer_risk_events ENABLE ROW LEVEL SECURITY;
-- No policies created → table is service-role-only by default. Webhook
-- + admin tooling use the service key; anon/authenticated cannot read
-- or write. Intentional: this is internal risk data.


-- ── Scoring RPC ───────────────────────────────────────────────────
-- Returns a small numeric score for a given (buyer_id, card_fingerprint)
-- pair. Higher = more risk. Lost / abusive disputes weigh far more
-- heavily than total dispute count (matches the checklist's "weight
-- lost disputes" guidance). Used by checkout to decide between
-- normal flow / manual-capture / hard block.
--
-- Score weights:
--   chargeback_lost  : +30 each
--   abuse_claim      : +25 each
--   chargeback_opened: +5  each (everyone gets disputes occasionally)
--   refund_partial   : +1  each
--   refund_full      : +2  each
--   admin_flag       : +50 each
DROP FUNCTION IF EXISTS public.compute_buyer_risk(text, uuid);
CREATE FUNCTION public.compute_buyer_risk(
  p_card_fingerprint text,
  p_buyer_id         uuid
) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $func$
DECLARE
  v_score int := 0;
BEGIN
  IF p_card_fingerprint IS NULL AND p_buyer_id IS NULL THEN
    RETURN 0;
  END IF;
  v_score := (
    SELECT coalesce(sum(
      CASE event_type
        WHEN 'chargeback_lost'   THEN 30
        WHEN 'abuse_claim'       THEN 25
        WHEN 'chargeback_opened' THEN 5
        WHEN 'chargeback_won'    THEN 0   -- evidence won — buyer wasn't lying, neutral
        WHEN 'refund_partial'    THEN 1
        WHEN 'refund_full'       THEN 2
        WHEN 'admin_flag'        THEN 50
        ELSE 0 END
    ), 0)::int
    FROM public.buyer_risk_events
    WHERE (p_card_fingerprint IS NOT NULL AND card_fingerprint = p_card_fingerprint)
       OR (p_buyer_id IS NOT NULL AND buyer_id = p_buyer_id)
  );
  RETURN v_score;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.compute_buyer_risk(text, uuid) TO authenticated, service_role;

-- ============================================================
-- Verify:
--   SELECT count(*) FROM buyer_risk_events;
--   SELECT compute_buyer_risk(NULL, '00000000-0000-0000-0000-000000000000'::uuid);
-- ============================================================
