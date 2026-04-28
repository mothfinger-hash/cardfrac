-- ============================================================
-- PathBinder Card Scanner — Supabase SQL Setup
-- Run this in Supabase > SQL Editor
-- ============================================================

-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create the catalog table
--    This holds every card from combined_final.xlsx + its CLIP embedding
create table if not exists catalog (
  id            text primary key,          -- "{set_code}-{card_number}" e.g. "base1-1"
  name          text not null,
  set_name      text,
  set_code      text,
  card_number   text,
  rarity        text,
  supertype     text,
  image_url     text,
  embedding     vector(512)               -- CLIP ViT-B/32 output, populated by generate_embeddings.py
);

-- 3. Index for fast approximate nearest-neighbor search
--    Build AFTER running generate_embeddings.py (needs data to exist first)
--    Run this line separately once embeddings are loaded:
--
--    create index cards_embedding_idx on catalog using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 4. Similarity search function
--    Called from the app scanner: sb.rpc('match_cards', { query_embedding, match_threshold, match_count })
create or replace function match_cards(
  query_embedding  vector(512),
  match_threshold  float    default 0.55,
  match_count      int      default 5
)
returns table (
  id          text,
  name        text,
  set_name    text,
  card_number text,
  rarity      text,
  image_url   text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.name,
    c.set_name,
    c.card_number,
    c.rarity,
    c.image_url,
    1 - (c.embedding <=> query_embedding) as similarity
  from catalog c
  where c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Grant access
grant select on catalog to anon, authenticated;
grant execute on function match_cards to anon, authenticated;

-- ============================================================
-- After loading embeddings, create the index:
--   create index cards_embedding_idx on catalog
--     using ivfflat (embedding vector_cosine_ops) with (lists = 100);
--
-- Verify with:
--   select count(*) from catalog;
--   select count(*) from catalog where embedding is not null;
-- ============================================================


-- ============================================================
-- SET SYMBOL CLASSIFIER — run this block in SQL Editor too
-- ============================================================

-- 6. Set symbols table (one row per Pokemon TCG set)
create table if not exists set_symbols (
  set_code    text primary key,   -- e.g. "base1", "swsh1"
  set_name    text not null,
  symbol_url  text,               -- https://images.pokemontcg.io/base1/symbol.png
  series      text,               -- e.g. "Base", "Sword & Shield"
  embedding   vector(512)         -- CLIP embedding of the symbol image
);

-- 7. Index for symbol similarity search
--    Run after embed_set_symbols.py completes:
--    create index set_symbols_embedding_idx on set_symbols
--      using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- 8. Set symbol match function
--    Called from scanner: sb.rpc('match_set_symbol', { query_embedding, match_count })
create or replace function match_set_symbol(
  query_embedding  vector(512),
  match_count      int default 3
)
returns table (
  set_code    text,
  set_name    text,
  series      text,
  symbol_url  text,
  similarity  float
)
language sql stable
as $$
  select
    s.set_code,
    s.set_name,
    s.series,
    s.symbol_url,
    1 - (s.embedding <=> query_embedding) as similarity
  from set_symbols s
  where s.embedding is not null
  order by s.embedding <=> query_embedding
  limit match_count;
$$;

-- 9. Grant access
grant select on set_symbols to anon, authenticated;
grant execute on function match_set_symbol to anon, authenticated;

-- 10. Exact card lookup by set_code + card_number (called after symbol+OCR match)
--     Fast primary key style lookup, no vector math needed
create or replace function lookup_card(
  p_set_code    text,
  p_card_number text
)
returns table (
  id          text,
  name        text,
  set_name    text,
  set_code    text,
  card_number text,
  rarity      text,
  image_url   text
)
language sql stable
as $$
  select id, name, set_name, set_code, card_number, rarity, image_url
  from catalog
  where set_code    = p_set_code
    and card_number = p_card_number
  limit 1;
$$;

grant execute on function lookup_card to anon, authenticated;
