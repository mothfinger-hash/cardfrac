-- Backfill image_url for the N's Zekrom Ascended Heroes ETB promo
-- by copying it from the regular Ascended Heroes printing (me2pt5-155).
--
-- The ETB promo (#31) and the main set printing (#155) share the
-- exact same illustration — the only difference is the foil pattern
-- (cosmos holo on the ETB promo). pokedata mirrors the regular
-- printing's image to scrydex, so we can reuse that URL here until
-- we have a true ETB-promo asset (which PC may never provide because
-- their thumbnail is a tiny 60×80 jpg).
--
-- If the main printing happens to be missing too (it shouldn't be,
-- but ¯\_(ツ)_/¯) the COALESCE keeps the promo row's image_url NULL
-- instead of writing 'null'-the-string.

UPDATE public.catalog
SET image_url = COALESCE(
  (SELECT image_url FROM public.catalog WHERE id = 'me2pt5-155'),
  image_url
)
WHERE id = 'en-promo-ahpromo-31';

-- Verify both rows side by side.
SELECT id, name, set_name, card_number, image_url
FROM public.catalog
WHERE id IN ('me2pt5-155', 'en-promo-ahpromo-31')
ORDER BY card_number;
