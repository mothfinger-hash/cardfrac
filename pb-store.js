// =========================================================
// PathBinder — My Store (lazy-loaded)
//
// Square-style POS view of the vendor's active marketplace
// listings. Renders each listing as a card tile in a responsive
// grid, with the price prominently displayed. Tapping a tile
// opens the binder detail modal (which already includes
// TCGplayer + PriceCharting external links via
// _renderBinderExtrasPlaceholder).
//
// Only loads on demand — vendor+ users get a stub in pb-app.js
// that lazy-loads this file the first time the My Store tab is
// activated. Free / Collector / Enthusiast users never download
// the file at all.
// =========================================================

(function() {
  'use strict';

  // ── Styles ──────────────────────────────────────────────────────
  // Injected on first run so we don't add to pb-styles.css. Keeps
  // the My Store CSS self-contained with the rest of the module.
  function _injectStoreStyles() {
    if (document.getElementById('pb-store-styles')) return;
    const css = `
      /* My Store grid — responsive Square-style POS tiles. Auto-fit
         minmax fits 5-6 columns on a wide desktop down to 2 on phones. */
      .pbs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 12px;
        padding: 4px 0;
      }
      /* Each tile is a card-shaped frame with price overlay + name strip
         underneath. Hover lifts and brightens the accent border so the
         vendor can tell which one their finger is on. */
      .pbs-tile {
        position: relative;
        display: flex;
        flex-direction: column;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        cursor: pointer;
        transition: transform .12s ease, border-color .12s, box-shadow .12s;
      }
      .pbs-tile:hover {
        transform: translateY(-2px);
        border-color: var(--accent);
        box-shadow: 0 6px 20px rgba(0,0,0,.45), 0 0 0 1px rgba(26,199,160,.15);
      }
      .pbs-tile:active { transform: translateY(0); }
      .pbs-tile-img-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 245 / 342;
        background: var(--surface2);
        overflow: hidden;
      }
      .pbs-tile-img-wrap img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .pbs-tile-img-wrap .pbs-img-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: var(--muted);
        font-family: 'Space Mono', monospace;
        font-size: 2rem;
      }
      /* Price badge — top-right corner of the image, Square POS feel. */
      .pbs-price {
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(0,0,0,.82);
        color: var(--green);
        font-family: 'Orbitron', monospace;
        font-weight: 800;
        font-size: .92rem;
        padding: 4px 9px;
        border-radius: 4px;
        border: 1px solid var(--accent);
        box-shadow: 0 2px 6px rgba(0,0,0,.5);
        letter-spacing: .02em;
      }
      /* Quantity pill — top-left when listing.quantity > 1. Indicates
         the vendor has multiple of the same card listed on one row. */
      .pbs-qty {
        position: absolute;
        top: 8px;
        left: 8px;
        background: rgba(0,0,0,.82);
        color: var(--text);
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        font-size: .68rem;
        padding: 3px 7px;
        border-radius: 4px;
        border: 1px solid var(--border);
        letter-spacing: .04em;
      }
      /* Variant tag (REVERSE HOLO etc.) — bottom-left of the image, copper-tinted. */
      .pbs-variant {
        position: absolute;
        bottom: 8px;
        left: 8px;
        background: rgba(0,0,0,.82);
        color: var(--copper, #d97e3e);
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        font-size: .56rem;
        padding: 2px 6px;
        border-radius: 3px;
        border: 1px solid var(--copper, #d97e3e);
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .pbs-tile-body {
        padding: 8px 10px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pbs-tile-name {
        font-family: 'Space Mono', 'Share Tech Mono', monospace;
        font-size: .8rem;
        color: var(--text);
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pbs-tile-meta {
        font-family: 'Space Mono', monospace;
        font-size: .62rem;
        color: var(--muted);
        letter-spacing: .04em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* Summary tiles row across the top of the store view */
      .pbs-summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-bottom: 16px;
      }
      .pbs-summary-tile {
        padding: 10px 12px;
        border: 1px solid var(--border);
        background: var(--surface);
        border-radius: 6px;
      }
      .pbs-summary-label {
        font-family: 'Space Mono', monospace;
        font-size: .58rem;
        color: var(--muted);
        letter-spacing: .08em;
      }
      .pbs-summary-value {
        font-family: 'Orbitron', monospace;
        font-size: 1.05rem;
        font-weight: 700;
        margin-top: 4px;
      }
      /* Phone breakpoint — bigger gap looks better in single column */
      @media (max-width: 480px) {
        .pbs-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .pbs-price { font-size: .8rem; padding: 3px 7px; }
        .pbs-tile-name { font-size: .72rem; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'pb-store-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Data fetch + cache ──────────────────────────────────────────
  // The store view reuses the in-memory `listings` array that other
  // parts of pb-app.js maintain (renderMyListings, renderBrowse,
  // etc.). On force-refresh we re-pull straight from Supabase so
  // any price edits made elsewhere come through.
  let _storeListingsCache = null;
  let _storeFetchInflight = null;

  async function _fetchStoreListings(force) {
    if (!force && _storeListingsCache) return _storeListingsCache;
    if (_storeFetchInflight) return _storeFetchInflight;
    _storeFetchInflight = (async function() {
      try {
        const r = await sb.from('listings')
          .select('*')
          .eq('seller_id', currentUser.id)
          .in('status', ['active', 'available'])
          .order('created_at', { ascending: false })
          .limit(500);
        if (r.error) {
          console.warn('[store] fetch error:', r.error.message);
          return [];
        }
        _storeListingsCache = r.data || [];
        return _storeListingsCache;
      } finally {
        _storeFetchInflight = null;
      }
    })();
    return _storeFetchInflight;
  }

  // ── Renderer ────────────────────────────────────────────────────
  async function renderMyStore(forceRefresh) {
    _injectStoreStyles();
    const wrap = document.getElementById('myStoreContent');
    if (!wrap) return;
    if (!currentUser) {
      wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted)">Sign in to view your store.</div>';
      return;
    }
    if (typeof tierAtLeast !== 'function' || !tierAtLeast('vendor')) {
      wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted)">'
        + 'My Store is a Vendor+ feature.<br>'
        + '<button onclick="openPricingModalWithPromo(\'vendor\')" class="pb-panel-link" '
        +   'style="border-color:var(--accent);color:var(--accent);margin-top:14px;display:inline-block">'
        +   'Upgrade to Vendor →'
        + '</button>'
        + '</div>';
      return;
    }

    const listings = await _fetchStoreListings(forceRefresh);
    const term = (document.getElementById('storeSearch')?.value || '').trim().toLowerCase();
    const sort = document.getElementById('storeSort')?.value || 'value_desc';

    // Filter
    let filtered = listings;
    if (term) {
      filtered = listings.filter(function(l) {
        const hay = ((l.name || '') + ' ' + (l.set_name || '') + ' ' + (l.set_code || '') + ' ' + (l.card_number || '')).toLowerCase();
        return hay.indexOf(term) >= 0;
      });
    }

    // Sort
    filtered = filtered.slice().sort(function(a, b) {
      if (sort === 'value_asc')  return (a.value || 0) - (b.value || 0);
      if (sort === 'name_asc')   return String(a.name || '').localeCompare(String(b.name || ''));
      if (sort === 'recent')     return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      return (b.value || 0) - (a.value || 0); // value_desc default
    });

    // Summary
    let totalValue = 0;
    let totalUnits = 0;
    filtered.forEach(function(l) {
      const qty = l.quantity || 1;
      totalValue += (Number(l.value) || 0) * qty;
      totalUnits += qty;
    });

    const summary = ''
      + '<div class="pbs-summary">'
      +   _summaryTile('Listings', String(filtered.length), 'var(--text)')
      +   _summaryTile('Units',    String(totalUnits),       'var(--accent)')
      +   _summaryTile('Value',    '$' + totalValue.toFixed(2), 'var(--green)')
      + '</div>';

    if (filtered.length === 0) {
      wrap.innerHTML = summary
        + '<div style="padding:40px;text-align:center;color:var(--muted);font-size:.78rem">'
        + (term
            ? 'No matching listings.'
            : 'No active listings yet. Click <strong style="color:var(--accent)">+ List a Card</strong> to start your store.')
        + '</div>';
      return;
    }

    const tiles = filtered.map(_tileHtml).join('');
    wrap.innerHTML = summary + '<div class="pbs-grid">' + tiles + '</div>';
  }

  function _summaryTile(label, value, color) {
    return ''
      + '<div class="pbs-summary-tile">'
      +   '<div class="pbs-summary-label">' + _esc(label) + '</div>'
      +   '<div class="pbs-summary-value" style="color:' + color + '">' + _esc(value) + '</div>'
      + '</div>';
  }

  function _tileHtml(l) {
    // Source the image from listing.photos[0] (vendor's uploaded
    // photo) preferentially; fall back to nothing rather than the
    // catalog stock photo because vendors typically want to see
    // THEIR card, not a generic mockup.
    const photo = (Array.isArray(l.photos) && l.photos[0]) || '';
    const name  = l.name || '?';
    const setLine = [l.set_name, l.card_number ? '#' + l.card_number : '']
      .filter(Boolean).join(' · ');
    const price = (typeof l.value === 'number') ? l.value : Number(l.value) || 0;
    const qty   = (l.quantity || 1);
    const variantTag = (l.variant && l.variant !== 'normal')
      ? '<span class="pbs-variant">' + _esc(String(l.variant).replace(/_/g, ' ')) + '</span>'
      : '';
    const qtyPill = qty > 1
      ? '<span class="pbs-qty">×' + qty + '</span>'
      : '';
    const imgEl = photo
      ? '<img src="' + _esc(photo) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
      : '';
    const placeholder = '<div class="pbs-img-placeholder"' + (photo ? ' style="display:none"' : '') + '>?</div>';
    // _escJsAttr is defined in pb-app.js — safe to reference because
    // pb-store.js is only loaded after the main bundle has parsed.
    const id = _escJsAttr(l.id);
    return ''
      + '<div class="pbs-tile" onclick="openStoreCardDetail(\'' + id + '\')">'
      +   '<div class="pbs-tile-img-wrap">'
      +     imgEl + placeholder
      +     qtyPill
      +     '<span class="pbs-price">$' + price.toFixed(2) + '</span>'
      +     variantTag
      +   '</div>'
      +   '<div class="pbs-tile-body">'
      +     '<div class="pbs-tile-name">' + _esc(name) + '</div>'
      +     (setLine ? '<div class="pbs-tile-meta">' + _esc(setLine) + '</div>' : '')
      +   '</div>'
      + '</div>';
  }

  // ── Card detail dispatch ────────────────────────────────────────
  // Tapping a tile resolves the listing to a collection_items row
  // (when api_card_id + variant match an owned row) so the
  // existing binder detail modal fires with TCGplayer + PriceCharting
  // external links via _renderBinderExtrasPlaceholder.
  //
  // If no collection row is linked (legacy listings without
  // api_card_id), we fall back to opening the public marketplace
  // listing detail so the vendor at least sees their own card.
  async function openStoreCardDetail(listingId) {
    const listings = _storeListingsCache || [];
    const l = listings.find(function(x) { return String(x.id) === String(listingId); });
    if (!l) {
      console.warn('[store] listing not found:', listingId);
      return;
    }
    // Prefer the collection row so we get the rich detail modal.
    if (l.api_card_id && typeof collectionItems !== 'undefined') {
      const variant = l.variant || 'normal';
      const owned = collectionItems.find(function(c) {
        return String(c.api_card_id) === String(l.api_card_id)
            && (c.variant || 'normal') === variant
            && !c.is_ghost && !c.sold_offline;
      });
      if (owned && typeof openBinderCardDetail === 'function') {
        return openBinderCardDetail(owned.id);
      }
    }
    // Fallback: open the marketplace listing detail view.
    if (typeof openListingDetail === 'function') {
      return openListingDetail(listingId);
    }
    // Last resort — show a toast pointing at the listing.
    if (typeof showToast === 'function') {
      showToast('Listing: ' + (l.name || listingId));
    }
  }

  // ── Helpers (local copies to keep the module self-contained) ────
  // _esc / _escJsAttr already exist in pb-app.js as globals; we just
  // reference them. But _esc is defined here as a local fallback in
  // case the loader order ever changes.
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Use the pb-app.js version if loaded, otherwise our local copy.
  if (typeof window._escHtml === 'function') { /* let pb-app define */ }

  // ── Expose to window (replaces the lazy-load stub in pb-app.js) ─
  window.renderMyStore = renderMyStore;
  window.openStoreCardDetail = openStoreCardDetail;
  // Invalidation hook — other code (e.g. a listing edit) can call
  // window._invalidateStoreCache() to force the next render to
  // re-fetch from Supabase instead of showing stale prices.
  window._invalidateStoreCache = function() { _storeListingsCache = null; };

  console.log('[store] /pb-store.js loaded');
})();
