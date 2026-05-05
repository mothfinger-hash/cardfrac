-- ============================================================
-- PathBinder — Multi-Language Card Prices Migration
-- Run in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Add language column to collection_items
ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'EN';

COMMENT ON COLUMN public.collection_items.language IS
  'Card print language: EN, JA, KR, FR, DE, ES, IT, PT, ZH';

-- 2. Centralised price cache (all sources, all languages)
CREATE TABLE IF NOT EXISTS public.card_prices (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  api_card_id  TEXT,                         -- Pokemon TCG API id (may be null for JP-only cards)
  card_name    TEXT NOT NULL,
  set_name     TEXT,
  card_number  TEXT,
  language     VARCHAR(5)  NOT NULL DEFAULT 'EN',
  source       VARCHAR(30) NOT NULL,         -- 'pricecharting' | 'cardmarket' | 'yuyutei'
  price_usd    NUMERIC(10,2),               -- always stored in USD for easy comparison
  price_local  NUMERIC(10,2),               -- original currency amount
  currency     VARCHAR(3)  DEFAULT 'USD',   -- JPY | EUR | USD etc.
  fx_rate      NUMERIC(12,6),               -- exchange rate used at time of fetch
  raw_data     JSONB,                        -- full API/scrape response for debugging
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint allows one price record per card+language+source
-- NULL api_card_id values are intentionally excluded from the unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_prices_api_lang_source
  ON public.card_prices (api_card_id, language, source)
  WHERE api_card_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_prices_name_lang_source
  ON public.card_prices (card_name, set_name, card_number, language, source);

CREATE INDEX IF NOT EXISTS idx_card_prices_lookup
  ON public.card_prices (api_card_id, language);

-- 3. RLS
ALTER TABLE public.card_prices ENABLE ROW LEVEL SECURITY;

-- Everyone can read prices
CREATE POLICY "Card prices are publicly readable"
  ON public.card_prices FOR SELECT USING (true);

-- Only service-role (Edge Functions) can write prices
CREATE POLICY "Service role manages card prices"
  ON public.card_prices FOR ALL
  USING (auth.role() = 'service_role');

-- 4. Auto-update updated_at
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS card_prices_updated_at ON public.card_prices;
CREATE TRIGGER card_prices_updated_at
  BEFORE UPDATE ON public.card_prices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
