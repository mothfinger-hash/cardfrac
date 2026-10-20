-- migration_oct2026_sets_metadata.sql
--
-- RUN THIS AFTER the ingest commit:
--   python3 ingest_missing_sets.py --only BETB,FB11 --commit
--
-- The ingest writes the cards to `catalog` but does NOT populate `set_metadata`,
-- which is what the Sets page reads for ordering (and, for Pokemon, visibility).
-- For non-Pokemon TCG the id is '<prefix><set_code>' lower-cased, matched by
-- _enrichTcgSetsWithReleaseDate against the catalog set_code.
--   Yu-Gi-Oh "Beyond the Brave"  -> catalog set_code BETB, id prefix ygo-  -> 'ygo-betb'
--   Dragon Ball "Brightness of Hope" -> set_code FB11, id prefix dbf-     -> 'dbf-fb11'
--
-- Idempotent. Run with the SERVICE key. Hard-refresh after (24h Sets cache).

insert into public.set_metadata (id, name, game_type, release_date)
values
  ('ygo-betb', 'Beyond the Brave',   'yugioh',   date '2026-10-09'),
  ('dbf-fb11', 'Brightness of Hope', 'dbfusion', date '2026-10-16')
on conflict (id) do update set
  name = excluded.name, game_type = excluded.game_type,
  release_date = excluded.release_date, updated_at = now();

-- verify:
-- select id, name, release_date from public.set_metadata where id in ('ygo-betb','dbf-fb11');
