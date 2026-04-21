-- Run this in your Supabase SQL editor:
-- Dashboard → SQL Editor → New Query → paste + run

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS price_source_url text;

-- Optional: add a comment so it's clear what this field is for
COMMENT ON COLUMN listings.price_source_url IS
  'URL of the market price source (TCGPlayer, eBay, PSA). Used by the auto price-update cron job. Admin-only — not exposed to users.';
