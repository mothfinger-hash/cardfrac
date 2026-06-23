-- Reversible card photos.
-- card_image_url stays "the image currently shown" (so all existing renders
-- are untouched). photo_url preserves the user's uploaded photo so switching
-- the displayed image back to the stock catalog image never loses it — the
-- card-detail toggle flips card_image_url between the stock image (looked up
-- from catalog via api_card_id) and photo_url.
--
-- Idempotent.
alter table public.collection_items
  add column if not exists photo_url text;

-- Backfill: any displayed image that's a user upload (card-photos bucket) IS
-- the user's photo by definition — remember it so the toggle can round-trip.
update public.collection_items
set photo_url = card_image_url
where photo_url is null
  and card_image_url like '%/card-photos/%';
