-- ============================================================
-- PathBinder — Demo / App Review seed data
-- ------------------------------------------------------------
-- Run AFTER:
--   1. Creating the review account in the Supabase Dashboard
--      (Authentication -> Users -> Add user, check "Auto Confirm User").
--   2. Setting its tier so reviewers see everything:
--        update public.profiles set subscription_tier = 'shop'
--        where id = (select id from auth.users where email = 'review@pathbinder.gg');
--
-- Safe to re-run: it clears THIS account's existing cards/listings first,
-- then reseeds. Touches only the demo user's rows. Idempotent.
--
-- Change the email below if you used a different review address.
-- ============================================================

DO $$
DECLARE
  v_email  text := 'review@pathbinder.gg';
  v_uid    uuid;
  v_ptype  text;   -- 'ARRAY' (text[]) or 'jsonb'
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Demo user % not found — create it in the Dashboard first.', v_email;
  END IF;

  -- ── Clean slate (re-run safe) ───────────────────────────────────────
  DELETE FROM public.listings         WHERE seller_id = v_uid;
  DELETE FROM public.collection_items WHERE user_id   = v_uid;

  -- ── 8 real Pokemon-EN singles into the binder ───────────────────────
  -- Picks the most valuable cards that have an image so the binder looks
  -- populated and recognizable. on_shelf_qty defaults to quantity (shop
  -- tier inventory pattern).
  INSERT INTO public.collection_items
    (user_id, api_card_id, card_name, set_name, card_number, card_image_url,
     game_type, condition, grade_value, quantity, on_shelf_qty,
     purchase_price, purchase_date, current_value, variant, notes)
  SELECT
    v_uid, c.id, c.name, c.set_name, c.card_number, c.image_url,
    'pokemon', 'raw', NULL, 1, 1,
    round(coalesce(c.current_value, 0)::numeric, 2),
    current_date - 14,
    round(coalesce(c.current_value, 0)::numeric, 2),
    'normal', 'demo_seed'
  FROM public.catalog c
  WHERE public.is_pokemon_en_id(c.id)
    AND c.image_url IS NOT NULL
    AND (c.product_type IS NULL OR c.product_type IN ('single','tcg_single'))
    AND c.current_value IS NOT NULL
    AND c.current_value BETWEEN 5 AND 400   -- believable spread, skips outliers
  ORDER BY c.current_value DESC
  LIMIT 8;

  -- ── List 3 of them on the marketplace ───────────────────────────────
  -- photos column type varies by environment (text[] vs jsonb); branch so
  -- the literal matches.
  SELECT data_type INTO v_ptype
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'photos';

  IF v_ptype = 'jsonb' THEN
    INSERT INTO public.listings
      (name, game_type, grade, value, shipping_price, status, seller_id,
       seller_name, is_vendor_listing, total_slots, quantity, photos,
       product_type, variant, api_card_id, card_number)
    SELECT
      ci.card_name, 'pokemon', 'Raw',
      round((ci.current_value * 1.10)::numeric, 2), 4.99, 'active', v_uid,
      'PathBinder Demo Shop', true, 1, 1,
      to_jsonb(array[ci.card_image_url]),
      'single', 'normal', ci.api_card_id, ci.card_number
    FROM public.collection_items ci
    WHERE ci.user_id = v_uid AND ci.notes = 'demo_seed'
    ORDER BY ci.current_value DESC
    LIMIT 3;
  ELSE
    INSERT INTO public.listings
      (name, game_type, grade, value, shipping_price, status, seller_id,
       seller_name, is_vendor_listing, total_slots, quantity, photos,
       product_type, variant, api_card_id, card_number)
    SELECT
      ci.card_name, 'pokemon', 'Raw',
      round((ci.current_value * 1.10)::numeric, 2), 4.99, 'active', v_uid,
      'PathBinder Demo Shop', true, 1, 1,
      array[ci.card_image_url],
      'single', 'normal', ci.api_card_id, ci.card_number
    FROM public.collection_items ci
    WHERE ci.user_id = v_uid AND ci.notes = 'demo_seed'
    ORDER BY ci.current_value DESC
    LIMIT 3;
  END IF;

  -- ── Reflect the listed units in the inventory split ─────────────────
  -- The 3 listed cards move from on_shelf -> listed_online so the
  -- My Store / inventory view is internally consistent.
  UPDATE public.collection_items ci
     SET on_shelf_qty = 0, listed_online_qty = 1
    FROM public.listings l
   WHERE ci.user_id  = v_uid
     AND l.seller_id = v_uid
     AND l.status    = 'active'
     AND l.api_card_id = ci.api_card_id;

  RAISE NOTICE 'Seeded demo account % (uid %): 8 cards, 3 listings.', v_email, v_uid;
END $$;

-- Verify what landed:
SELECT 'collection_items' AS tbl, count(*) AS rows
  FROM public.collection_items
 WHERE user_id = (SELECT id FROM auth.users WHERE email = 'review@pathbinder.gg')
UNION ALL
SELECT 'listings (active)', count(*)
  FROM public.listings
 WHERE seller_id = (SELECT id FROM auth.users WHERE email = 'review@pathbinder.gg')
   AND status = 'active';
