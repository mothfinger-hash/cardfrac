-- ============================================================
-- CardFrac Stripe Setup SQL
-- Run this once in Supabase → SQL Editor
-- ============================================================

-- 1. Table for tracking pending Stripe checkout sessions
--    The webhook reads this to know which slots to assign after payment.
CREATE TABLE IF NOT EXISTS pending_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid REFERENCES auth.users(id) NOT NULL,
  type text NOT NULL,                        -- 'slot_purchase' | 'secondary_purchase' | 'membership'
  items jsonb NOT NULL DEFAULT '[]',         -- [{ listingId, listingName, slotIdx, priceCents }]
  total_cents integer NOT NULL DEFAULT 0,
  stripe_session_id text,
  status text NOT NULL DEFAULT 'pending',    -- 'pending' | 'completed' | 'cancelled'
  created_at timestamptz DEFAULT now()
);

ALTER TABLE pending_checkouts ENABLE ROW LEVEL SECURITY;

-- Users can view their own checkouts (for debugging / receipts)
CREATE POLICY "Users can view own checkouts"
  ON pending_checkouts FOR SELECT
  USING (buyer_id = auth.uid());

-- Service role (webhook) can insert/update without RLS
-- No INSERT policy needed for anon/authenticated — the edge function uses service role key

-- 2. Add membership columns to profiles (if they don't already exist)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_premium boolean DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership_plan text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership_started_at timestamptz;

-- 3. Ensure slots table has ask_price and trade_open columns
--    (webhook sets these to null/false on purchase)
ALTER TABLE slots ADD COLUMN IF NOT EXISTS ask_price numeric;
ALTER TABLE slots ADD COLUMN IF NOT EXISTS trade_open boolean DEFAULT false;

-- 4. Ensure transactions table has fee column
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee numeric DEFAULT 0;
