-- Add the N's Zekrom Ascended Heroes ETB promo (#31) to catalog.
--
-- Why this migration exists:
--   pokedata.io tracks the regular Ascended Heroes N's Zekrom at
--   me2pt5-155, but not the ETB promo printing (#31) that comes with
--   the Ascended Heroes Elite Trainer Box. PriceCharting catalogues
--   that promo under their generic 'pokemon-promo' console at URL
--     https://www.pricecharting.com/game/pokemon-promo/n's-zekrom-31
--   which is NOT in our pokemon_cards_pricechart.csv export, so the
--   periodic sync scripts will never pick it up automatically.
--
-- ID convention:
--   en-promo-ahpromo-31 — 'en-promo' identifies an English promo that
--   isn't in pokedata; 'ahpromo' is the made-up set_code for the
--   Ascended Heroes ETB promo set; '31' is the card number. Keeps
--   us from colliding with any future pokedata row that uses the
--   standard 'me2pt5-...' prefix.
--
-- Set_code 'ahpromo' is intentionally short and lowercase so it
-- groups cleanly with future ETB-promo inserts (e.g. ahpromo-32,
-- ahpromo-33 for other cards in the same promo set).

INSERT INTO public.catalog (
  id,
  name,
  set_name,
  set_code,
  card_number,
  rarity,
  supertype,
  image_url,
  game_type,
  product_type,
  price_source_url
)
VALUES (
  'en-promo-ahpromo-31',
  'N''s Zekrom',
  'Ascended Heroes Promo',
  'ahpromo',
  '31',
  'Promo',
  'Pokémon',
  -- Image URL — pokedata's image CDN format for the base printing is
  -- https://images.scrydex.com/pokemon/me2pt5-155/small but it's a
  -- different artwork for the ETB promo. Leave NULL for now; nightly
  -- image-mirror job will fill it in once PC scrape grabs the asset,
  -- or paste it manually if you have it.
  NULL,
  'pokemon',
  'single',
  'https://www.pricecharting.com/game/pokemon-promo/n''s-zekrom-31'
)
ON CONFLICT (id) DO UPDATE SET
  name              = EXCLUDED.name,
  set_name          = EXCLUDED.set_name,
  set_code          = EXCLUDED.set_code,
  card_number       = EXCLUDED.card_number,
  rarity            = EXCLUDED.rarity,
  image_url         = COALESCE(EXCLUDED.image_url, public.catalog.image_url),
  price_source_url  = EXCLUDED.price_source_url;

-- Verify:
SELECT id, name, set_name, card_number, rarity, image_url, price_source_url
FROM public.catalog
WHERE id = 'en-promo-ahpromo-31';
