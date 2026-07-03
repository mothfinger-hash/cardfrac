-- migration_tcgcsv_apply_links_rpc.sql
--
-- Bulk PARTIAL update for the TCGCSV backfill. PostgREST's upsert is
-- insert-or-replace, so it requires every NOT NULL catalog column even when
-- we only want to set two fields — which 400s. This function takes a JSON
-- array of {id, tcgplayer_product_id, tcgplayer_url} and updates just those
-- two columns per row, in ONE set-based statement, so the sync can write
-- hundreds of links per request instead of one PATCH per card.
--
-- Idempotent. Safe to re-run.

CREATE OR REPLACE FUNCTION public.apply_tcgplayer_links(p jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.catalog c
     SET tcgplayer_product_id = x.tcgplayer_product_id,
         tcgplayer_url        = x.tcgplayer_url
    FROM jsonb_to_recordset(p)
           AS x(id text, tcgplayer_product_id bigint, tcgplayer_url text)
   WHERE c.id = x.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_tcgplayer_links(jsonb) TO authenticated, service_role;
