-- ─────────────────────────────────────────────────────────────────────────
-- Do we have Japanese sealed product in the catalog?
-- Japanese Pokémon sealed uses the id convention `sealed-jp-pc-{id}`
-- (singles are `jp-…`; sealed is `sealed-jp-…`). See sync_sealed_products.py.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Quick yes/no + count
select count(*) as jp_sealed_count
from catalog
where id like 'sealed-jp-%';

-- 2) Breakdown by product type (etb, utb, booster box, etc.)
select product_type, count(*) as n
from catalog
where id like 'sealed-jp-%'
group by product_type
order by n desc;

-- 3) Sample rows to eyeball
select id, name, set_name, product_type, game_type, price_source_url
from catalog
where id like 'sealed-jp-%'
order by set_name, name
limit 50;

-- 4) Context: sealed counts by language/game prefix for comparison
select
  case
    when id like 'sealed-jp-%'  then 'pokemon-jp'
    when id like 'sealed-en-%'  then 'pokemon-en'
    when id like 'sealed-mtg-%' then 'mtg'
    when id like 'sealed-ygo-%' then 'ygo'
    when id like 'sealed-op-%'  then 'one-piece'
    when id like 'sealed-%'     then 'other-sealed'
    else 'non-sealed'
  end as bucket,
  count(*) as n
from catalog
group by 1
order by n desc;

-- 5) (Optional) Are users actually holding / listing JP sealed?
select 'collection_items' as src, count(*) as n
from collection_items where api_card_id like 'sealed-jp-%'
union all
select 'listings', count(*)
from listings where api_card_id like 'sealed-jp-%';
