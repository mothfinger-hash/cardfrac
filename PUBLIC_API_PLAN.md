# PathBinder Public API — Planning Doc

Status: not built. This is the design we'd ship when we're ready.

## One-line pitch

> A REST API for the TCG ecosystem: live card prices, listings, set
> data, and aggregated sales prints — sourced from PathBinder's
> catalog and our own marketplace.

## Why this is worth building (and why later, not now)

**Moat.** Anyone can hit Scryfall or pokemontcg.io. What nobody else
has is real, recent transaction prices from a marketplace + shop
inventory ledger. The longer `shop_sales` and the PathBinder
marketplace accumulate data, the more uniquely useful our endpoints
get. v0 today would just be a re-wrapper of public sources.

**Wait until we have:**
- 90+ days of `shop_sales` rows from at least 3 active shops, OR
- 1000+ completed marketplace orders, OR
- A specific paying partner asking for the integration.

Whichever comes first is the trigger. Until then, this doc waits.

## Data assets we own

| Asset | Source | Freshness | API value |
|------|--------|-----------|-----------|
| Catalog | Mirrored from Scryfall, pokemontcg.io, YGOPRODeck, PriceCharting | Daily | Low — it's already free elsewhere |
| Set metadata + logos | Same | Daily | Low — same |
| `catalog_price_history` | PriceCharting CSVs + scrape | Daily | **High** — clean cross-TCG history in one place |
| Live listings (marketplace) | PathBinder users | Real-time | **High** — current supply signal |
| Movers (24h / 7d) | Derived from catalog_price_history | Daily | **High** — already powers /movers in Discord |
| Marketplace order prints | `orders` table | Real-time | **Very high** — actual transaction prices, not asks |
| In-store sales | `shop_sales` (Step 2) | Real-time | **Very high** — wholesale + retail floor reality |

The bottom three are the differentiated product. The top two are commodity.

## Proposed endpoints (v1)

### Public (no auth, rate-limited by IP)

```
GET /api/v1/catalog/cards/:id
GET /api/v1/catalog/sets
GET /api/v1/catalog/sets/:id/cards
GET /api/v1/catalog/cards/search?q=&game=&page=
```

Catalog metadata only. No prices in the free tier.

### Authenticated free tier (signed up for an API key)

```
GET /api/v1/cards/:id/price            # latest aggregated price, daily-aggregated history
GET /api/v1/cards/:id/listings         # current marketplace listings, anonymized seller
GET /api/v1/movers?period=7d&game=     # daily-cached
```

100 req/min, attribution required ("Powered by PathBinder" badge or
attribution link). Free for hobby projects, dashboards, Discord bots.

### Paid tier

```
GET /api/v1/cards/:id/price/realtime   # latest tick
GET /api/v1/cards/:id/history?range=1y # 1-minute resolution history
GET /api/v1/cards/:id/sales            # aggregated transaction prints — n, mean, median, p10, p90
GET /api/v1/listings/stream            # SSE / webhook for new listings
GET /api/v1/movers?period=1h           # hourly movers
POST /api/v1/wholesale/inquiry         # B2B inquiry endpoint into vendor inboxes
```

10k req/min. No attribution required. SLA on uptime + freshness.

### Pro tier (negotiated, enterprise)

- Direct read-replica access to a curated subset of tables.
- Daily bulk dump of `catalog_price_history` + `shop_sales` aggregates.
- Bring-your-own-domain branding.

## What NOT to expose (ever)

- Buyer / seller PII (names, addresses, emails, payment method strings)
- Stripe IDs, payout amounts, fees
- Individual `shop_sales` rows — only aggregates per (api_card_id, day, variant). Individual sale prices reveal too much about a specific shop's margins.
- `collection_items` — that's private inventory, not public-facing
- Subscription / tier info per user
- Direct messages, order messages, dispute logs

## Auth model

**API keys, not OAuth.** API consumers are headless services (bots,
dashboards), not end users. Issue a key per project from a new
`/api/keys` page in the Account → Settings area. Keys carry:
- `key_prefix` (public, looks like `pbk_live_abc...`)
- `tier` (free / paid / pro)
- `rate_limit_per_min` (denormalized from tier)
- `created_at`, `last_used_at`, `revoked_at`
- `monthly_quota` (paid tier — bytes downloaded or requests made)

Bearer auth: `Authorization: Bearer pbk_live_abc...`. Validate via
Edge Function lookup against a `api_keys` Supabase table (RLS:
service role only). Cache valid keys in memory for 60s to avoid a
DB hit per request.

## Rate limiting

Edge-level limiter keyed by `(api_key OR ip)`. Sliding window in Redis
(Upstash REST API — fits the Vercel deployment we already have).
Free tier IP-only: 30 req/min. Free tier with key: 100 req/min.
Paid: 10k req/min. Pro: negotiated.

Return `429 Too Many Requests` with `Retry-After` and
`X-RateLimit-Remaining` / `X-RateLimit-Reset` headers. Standard stuff.

## Tech approach

**Don't reinvent Supabase.** Supabase already exposes a PostgREST
layer over our tables. The work is:
1. Lock down RLS so the only thing PostgREST will serve publicly is
   what we want public (most tables stay private).
2. Build a thin Vercel Edge wrapper at `/api/v1/*` that:
   - Validates the API key
   - Applies rate limiting
   - Translates the friendly URL to the right Supabase query
   - Strips PII / shapes the response
   - Emits CORS headers
3. Cache responses at the edge via Vercel's stale-while-revalidate
   for endpoints that don't need to be sub-second (catalog metadata,
   daily history).

Estimated build for v1: **2-3 weeks** of focused work once we pull
the trigger. The largest line item is the docs site, not the code.

## Monetization

| Tier | Price | Limit | Who buys |
|------|-------|-------|----------|
| Public | Free | 30/min by IP | Casual lookups, attribution-requiring projects |
| Hobby | Free w/ key | 100/min | Discord bots, side projects, hobby dashboards |
| Builder | $29/mo | 1k/min, 1M req/mo | Indie SaaS, analytics tools, content sites |
| Business | $99/mo | 10k/min, 25M req/mo | LGS networks, larger Discord communities, affiliate sites |
| Enterprise | Negotiated | Custom | Buylist services, ML researchers, anyone wanting bulk dumps |

Free tiers exist to seed the ecosystem (Discord bots especially are
free advertising). Money lives at Builder+ where the differentiated
endpoints (realtime, sales aggregates, listing stream) gate behind
the paywall.

## Pre-launch checklist

When the trigger fires (90 days of sales OR 1k orders OR paying
partner), do these in order:

1. **Schema cleanup**
   - Audit every table's RLS — are read policies as tight as they
     need to be for what's currently consumer-facing? Are write
     policies bulletproof against an API key being misused?
   - Add a `pii_safe` view for any table the API will read from —
     stripped of names/emails/addresses, joined down to just the
     publicly-shareable columns. PostgREST exposes views the same as
     tables, so this keeps the surface clean.

2. **`api_keys` table + UI**
   - Migration: `api_keys (id, user_id, key_hash, key_prefix, tier,
     rate_limit_per_min, monthly_quota, created_at, last_used_at,
     revoked_at)`.
   - Account → Settings → API Keys panel: generate, rename, revoke,
     see usage chart.
   - Edge function to validate + log usage.

3. **`/api/v1/*` Edge routes**
   - Start with the 4 catalog endpoints (no auth) + 3 free-tier
     endpoints (key required). Don't ship realtime / streaming until
     a paying customer asks.

4. **Docs site**
   - `api.pathbinder.tcg/docs` (or `pathbinder.tcg/docs`).
   - OpenAPI spec + a quickstart per language (curl / JS / Python).
   - Live "try it" widget that uses a public sandbox key.

5. **Status page**
   - `status.pathbinder.tcg` — uptime histogram, latency p50/p95,
     incident log. UptimeRobot or Better Stack.

6. **Terms + attribution**
   - Update ToS to cover API usage, redistribution restrictions
     (don't resell our data as a competing data feed), and the
     attribution requirement for free tier.

## Out of scope for v1

- Write endpoints. v1 is read-only. No `POST /listings`, no
  `POST /orders`. Anyone wanting to write should use the existing
  buyer flow on the site.
- Webhooks. Nice to have for "ping me when price crosses X" but
  that's already in the `price_alerts` table for PathBinder users —
  not a v1 API feature.
- GraphQL. PostgREST + JSON is enough for the use cases that matter.
  Revisit if a paying customer specifically needs it.
- Auth for end users. API keys are for headless services. End users
  who want to "do PathBinder things from another app" should use the
  PathBinder site or the Discord bot.

## Risks to think about before pulling the trigger

- **Data leakage via aggregates.** A small shop with one Black Lotus
  sale could be identified by a sufficiently determined querier. We
  mitigate by only exposing aggregates with `n >= 5` per
  (card, day, variant) bucket — fewer than 5 sales for that bucket
  means we return null instead of the print.
- **Scraping the scraper.** Someone could build a competing data
  product by hammering our API. Free tier rate limits are the first
  defense; the second is the ToS + terms-of-use clause that
  prohibits redistribution as a data feed.
- **Catalog provenance.** Most of our catalog is mirrored from
  external APIs (Scryfall, pokemontcg.io) that themselves have ToS
  about redistribution. The exposed catalog endpoints should
  reference attribution back to the original sources where
  applicable — Scryfall, pokemontcg.io, YGOPRODeck all want credit.
- **Stripe ToS.** API can NEVER expose order amounts, payouts, fees,
  or Connect IDs. Stay on the read-only public-data side of the
  ledger. Real-money flows are not API surfaces.

## TL;DR

We have the column wired up. We have the sales ledger schema. As
shops start logging sales and the marketplace fills up, the data
becomes valuable. When the trigger fires, follow the pre-launch
checklist top-to-bottom — should be 2-3 weeks of focused work to a
publicly-shippable v1.

Until then: do nothing. Keep this doc updated when the schema
changes in ways that affect what we'd expose.
