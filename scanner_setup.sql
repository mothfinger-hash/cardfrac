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
