-- migration_30th_celebration_logos.sql
--
-- Gives the 30th Celebration sets a cover image on the Sets page. The ingest +
-- release-date migration created the set_metadata rows (id '30C' / '30CC') but
-- left logo_url / symbol_url null, so the tiles render text-only.
--
-- Source: the official set logo from pokemontcg.io (hosted on scrydex.com),
-- sets me55 / me55c = "30th Celebration" / "...: Classic Collection".
-- Verified the URLs return image/png 200 and there is no CSP blocking the host,
-- and _loadEnSetsFromDb maps set_metadata.logo_url -> the tile's images.logo.
-- Idempotent. Run with the SERVICE key. Hard-refresh after (24h Sets cache).
--
-- (Optional follow-up for consistency with other sets: mirror these into the
--  set-logos Supabase bucket and point logo_url/symbol_url there instead.)

update public.set_metadata set
  logo_url   = 'https://images.scrydex.com/pokemon/me55-logo/logo',
  symbol_url = 'https://images.scrydex.com/pokemon/me55-symbol/symbol',
  updated_at = now()
where id = '30C';

update public.set_metadata set
  logo_url   = 'https://images.scrydex.com/pokemon/me55c-logo/logo',
  symbol_url = 'https://images.scrydex.com/pokemon/me55c-symbol/symbol',
  updated_at = now()
where id = '30CC';

-- verify:
-- select id, name, logo_url from public.set_metadata where id in ('30C','30CC');
