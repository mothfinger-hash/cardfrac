// =========================================================
// PathBinder — My Store (lazy-loaded)
//
// POS-style storefront view that unifies what used to be split
// between My Store and the Inventory tab. Shows the vendor's
// full owned inventory as a tile grid with:
//   • Card image + name + set
//   • On-shelf qty (in-store stock)
//   • Listed qty + price (when on the marketplace)
//   • Variant tag
//   • $ SOLD action — opens Mark N Sold modal for that row
//   • + LIST action — opens List Card modal for unlisted cards
//
// Header includes a ⊞ POS SCAN button that flips the scanner
// into POS sale mode (existing openPosSaleScanner from pb-scanner.js).
//
// Tapping a tile opens the binder detail modal, which already
// surfaces TCGplayer + PriceCharting links via
// _renderBinderExtrasPlaceholder.
//
// Lazy-loaded — vendor+ users get a stub in pb-app.js that pulls
// this file the first time the My Store tab is activated.
// =========================================================

(function() {
  'use strict';

  // ── Styles ──────────────────────────────────────────────────────
  function _injectStoreStyles() {
    if (document.getElementById('pb-store-styles')) return;
    const css = `
      .pbs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 12px;
        padding: 4px 0;
      }
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
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .pbs-img-placeholder {
        display: flex; align-items: center; justify-content: center;
        width: 100%; height: 100%;
        color: var(--muted);
        font-family: 'Space Mono', monospace;
        font-size: 2rem;
      }
      /* Price badge — top-right when listed. Shows the listing.value. */
      .pbs-price {
        position: absolute;
        top: 8px; right: 8px;
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
      /* When the card isn't listed, swap the price badge for an
         "UNLISTED" tag so the vendor sees what needs attention. */
      .pbs-unlisted {
        position: absolute;
        top: 8px; right: 8px;
        background: rgba(0,0,0,.82);
        color: var(--muted);
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        font-size: .56rem;
        padding: 3px 7px;
        border-radius: 4px;
        border: 1px solid var(--border);
        letter-spacing: .08em;
      }
      /* Top-left chip: on-shelf / total split. "5/8" = 5 on shelf of
         8 total owned. Helps the vendor see at a glance which cards
         are running low. */
      .pbs-stock {
        position: absolute;
        top: 8px; left: 8px;
        background: rgba(0,0,0,.82);
        color: var(--text);
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        font-size: .66rem;
        padding: 3px 7px;
        border-radius: 4px;
        border: 1px solid var(--border);
        letter-spacing: .04em;
      }
      .pbs-stock.is-low    { color: var(--yellow,#FFD23F); border-color: var(--yellow,#FFD23F); }
      .pbs-stock.is-empty  { color: var(--red,#C8002A); border-color: var(--red,#C8002A); }
      /* Variant tag — bottom-left, copper-tinted. */
      .pbs-variant {
        position: absolute;
        bottom: 8px; left: 8px;
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
      /* Action button row — overlaid on the bottom of the image so
         the vendor can ring up / list without opening the detail. */
      .pbs-actions {
        position: absolute;
        bottom: 8px; right: 8px;
        display: flex; gap: 4px;
        z-index: 2;
      }
      .pbs-action-btn {
        background: rgba(0,0,0,.82);
        color: var(--accent);
        border: 1px solid var(--accent);
        font-family: 'Space Mono', monospace;
        font-weight: 800;
        font-size: .65rem;
        padding: 4px 9px;
        border-radius: 4px;
        cursor: pointer;
        letter-spacing: .06em;
        transition: all .12s;
      }
      .pbs-action-btn:hover { background: var(--accent); color: var(--text-on-accent); }
      .pbs-action-btn:disabled { opacity: .45; cursor: not-allowed; }
      .pbs-action-btn.is-list { color: var(--copper, #d97e3e); border-color: var(--copper, #d97e3e); }
      .pbs-action-btn.is-list:hover { background: var(--copper, #d97e3e); color: var(--surface); }
      .pbs-tile-body {
        padding: 8px 10px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pbs-tile-name {
        font-family: 'Space Mono', monospace;
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
      /* Summary tiles row */
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
      @media (max-width: 480px) {
        .pbs-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .pbs-price { font-size: .8rem; padding: 3px 7px; }
        .pbs-tile-name { font-size: .72rem; }
        .pbs-action-btn { font-size: .58rem; padding: 3px 7px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'pb-store-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Build a unified per-card view from collection_items + listings.
  // Each entry in the returned array represents one (api_card_id,
  // variant) pair, with stock + listing info merged in.
  function _buildStoreEntries() {
    if (typeof collectionItems === 'undefined') return [];
    // Active marketplace listings keyed by api_card_id|variant so we
    // can attach the price / listing id to the matching inventory row.
    const listingMap = {};
    if (typeof listings !== 'undefined' && Array.isArray(listings)) {
      listings.forEach(function(l) {
        if (!l || l.status === 'inactive' || l.status === 'sold') return;
        if (!l.api_card_id) return;
        const key = String(l.api_card_id) + '|' + (l.variant || 'normal');
        if (!listingMap[key]) listingMap[key] = [];
        listingMap[key].push(l);
      });
    }
    return collectionItems
      .filter(function(c) {
        return c && !c.is_ghost && !c.sold_offline;
      })
      .map(function(c) {
        const key = String(c.api_card_id || '') + '|' + (c.variant || 'normal');
        const matchingListings = listingMap[key] || [];
        // Use the first listing's value for the displayed price; sum
        // their quantities to get total listed.
        let listedQty = 0, listedValue = null, listingId = null;
        matchingListings.forEach(function(l) {
          listedQty += (l.quantity || 1);
          if (listedValue == null) {
            listedValue = Number(l.value) || 0;
            listingId = l.id;
          }
        });
        const totalQty   = c.quantity || 0;
        const onShelfQty = (c.on_shelf_qty != null) ? c.on_shelf_qty : totalQty;
        return {
          collection_item_id: c.id,
          api_card_id:        c.api_card_id,
          name:               c.card_name || '?',
          set_name:           c.set_name || '',
          card_number:        c.card_number || '',
          card_image_url:     c.card_image_url || '',
          variant:            c.variant || 'normal',
          totalQty:           totalQty,
          onShelfQty:         onShelfQty,
          listedQty:          listedQty,
          listedValue:        listedValue,
          listingId:          listingId,
          _raw:               c,
        };
      });
  }

  // ── Renderer ────────────────────────────────────────────────────
  // How many tiles to paint per page. A vendor with 5,000 cards
  // generating 5,000 tile HTML strings + a single innerHTML assignment
  // locks mobile Safari for tens of seconds with no progress shown —
  // that was the "loading for 30 seconds" symptom. Cap the initial
  // paint at PAGE_SIZE; users can tap "Show more" to add another
  // batch. Search/sort still operate over the full filtered list,
  // they just render the first PAGE_SIZE results.
  const PAGE_SIZE = 120;
  let _renderedCount = PAGE_SIZE;

  async function renderMyStore(forceRefresh) {
    try {
      return await _renderMyStoreImpl(forceRefresh);
    } catch (err) {
      // Visible error instead of the silent "Loading store…" hang.
      // The global error handler still fires, but this also paints
      // the actual exception INTO the My Store container so a user
      // (or me reading their screenshot) can see what blew up
      // instead of staring at the loading placeholder forever.
      console.error('[store] renderMyStore failed:', err);
      const wrap = document.getElementById('myStoreContent');
      if (wrap) {
        const msg = (err && err.message) ? err.message : String(err || 'unknown');
        wrap.innerHTML = '<div style="padding:24px;color:var(--red,#ef4444);font-size:.78rem;font-family:\'Space Mono\',monospace;line-height:1.5">'
          + '<div style="font-weight:700;letter-spacing:.08em;margin-bottom:8px;color:var(--red,#ef4444)">⚠ Store failed to render</div>'
          + '<div style="color:var(--muted);font-size:.7rem;word-break:break-word">'
          +   _esc(msg)
          + '</div>'
          + '<button onclick="renderMyStore(true)" class="pb-panel-link" style="margin-top:14px;border-color:var(--accent);color:var(--accent)">Retry</button>'
          + '</div>';
      }
    }
  }

  async function _renderMyStoreImpl(forceRefresh) {
    _injectStoreStyles();
    const wrap = document.getElementById('myStoreContent');
    if (!wrap) return;
    // Defensive: collectionItems is a `let` in pb-app.js's script
    // scope, which classic-script lexical scoping makes visible
    // here. But if the script load order ever flipped (or a future
    // refactor moves it into a module/IIFE), the reference would
    // throw a ReferenceError before _buildStoreEntries' typeof
    // guard fires. Probe explicitly so we get a clean error message
    // instead of a TDZ throw deep in the stack.
    try {
      // eslint-disable-next-line no-unused-expressions
      collectionItems;
    } catch (e) {
      wrap.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:.78rem;text-align:center">'
        + 'Inventory data not loaded yet. Try refreshing the page in a moment.'
        + '</div>';
      return;
    }
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
    // Optional force-refresh — re-pull collection from server so the
    // grid reflects any sales/edits made on another device.
    if (forceRefresh) {
      wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:.78rem">Refreshing inventory…</div>';
      try { if (typeof loadCollection === 'function') await loadCollection(); } catch(_) {}
    }

    const entries = _buildStoreEntries();
    const term = (document.getElementById('storeSearch')?.value || '').trim().toLowerCase();
    const sort = document.getElementById('storeSort')?.value || 'value_desc';

    let filtered = entries;
    if (term) {
      filtered = entries.filter(function(e) {
        const hay = (e.name + ' ' + e.set_name + ' ' + e.card_number).toLowerCase();
        return hay.indexOf(term) >= 0;
      });
    }
    filtered = filtered.slice().sort(function(a, b) {
      if (sort === 'value_asc')  return (a.listedValue || 0) - (b.listedValue || 0);
      if (sort === 'name_asc')   return String(a.name).localeCompare(String(b.name));
      if (sort === 'recent')     return String(b._raw && b._raw.created_at || '').localeCompare(String(a._raw && a._raw.created_at || ''));
      return (b.listedValue || 0) - (a.listedValue || 0);
    });

    // Summary
    let totalUnits = 0, totalOnShelf = 0, totalListed = 0, totalValue = 0;
    filtered.forEach(function(e) {
      totalUnits   += e.totalQty;
      totalOnShelf += e.onShelfQty;
      totalListed  += e.listedQty;
      if (e.listedValue) totalValue += e.listedValue * e.listedQty;
    });
    const summary = ''
      + '<div class="pbs-summary">'
      +   _summaryTile('Cards',     String(filtered.length),  'var(--text)')
      +   _summaryTile('Units',     String(totalUnits),       'var(--text)')
      +   _summaryTile('On Shelf',  String(totalOnShelf),     'var(--accent)')
      +   _summaryTile('Listed',    String(totalListed),      'var(--copper, #d97e3e)')
      +   _summaryTile('Listed $',  '$' + totalValue.toFixed(2), 'var(--green)')
      + '</div>';

    if (filtered.length === 0) {
      wrap.innerHTML = summary
        + '<div style="padding:40px;text-align:center;color:var(--muted);font-size:.78rem">'
        + (term
            ? 'No matching cards.'
            : 'No inventory yet. Add cards via the binder to start your store.')
        + '</div>';
      return;
    }

    // Paint the summary tiles immediately + a placeholder for the grid,
    // then yield to the event loop so the user sees progress while the
    // tile HTML is being assembled. Without this, a vendor with 5k+
    // cards saw "Loading store…" until the entire grid HTML was built
    // and assigned — 30+ seconds on mobile, no intermediate paint.
    wrap.innerHTML = summary
      + '<div style="padding:24px;text-align:center;color:var(--muted);font-size:.72rem;letter-spacing:.06em">'
      +   'Rendering ' + Math.min(filtered.length, _renderedCount).toLocaleString()
      +   (filtered.length > _renderedCount ? ' of ' + filtered.length.toLocaleString() : '')
      +   ' cards…'
      + '</div>';
    await new Promise(function(r) { setTimeout(r, 0); });

    const visible = filtered.slice(0, _renderedCount);
    const tiles   = visible.map(_tileHtml).join('');
    // Infinite-scroll sentinel — a 1px-tall <div id="pbs-sentinel"> at
    // the bottom of the grid. _attachStoreScrollLoader hooks an
    // IntersectionObserver on it that bumps _renderedCount and
    // re-renders when it crosses the viewport. Replaces the manual
    // "Show more" button so the vendor can just keep scrolling.
    const hasMore   = filtered.length > visible.length;
    const remaining = hasMore ? (filtered.length - visible.length) : 0;
    const sentinel  = hasMore
      ? '<div id="pbs-sentinel" data-remaining="' + remaining + '" '
        +     'style="grid-column:1 / -1;text-align:center;padding:18px 0;color:var(--muted);font-size:.7rem;letter-spacing:.06em">'
        +   'Loading ' + remaining.toLocaleString() + ' more…'
        + '</div>'
      : '';
    wrap.innerHTML = summary + '<div class="pbs-grid">' + tiles + sentinel + '</div>';
    if (hasMore) _attachStoreScrollLoader(filtered);
  }

  // Bumps the page size and re-renders so the next batch lands in the
  // grid. Each crossing adds another PAGE_SIZE tiles — keeps the main
  // thread free between batches instead of painting the entire
  // inventory at once. Still exposed as window._storeShowMore for
  // older code paths / manual debugging.
  window._storeShowMore = function() {
    _renderedCount += PAGE_SIZE;
    renderMyStore();
  };

  // IntersectionObserver that watches the bottom-of-grid sentinel.
  // When the user scrolls within ~600px of the sentinel, we render
  // the next batch. The observer disconnects on each re-render and
  // is reattached to the new sentinel — easier than tracking a single
  // long-lived observer across DOM swaps.
  let _storeObserver = null;
  function _attachStoreScrollLoader(filteredRef) {
    try {
      if (_storeObserver) { _storeObserver.disconnect(); _storeObserver = null; }
      const sentinel = document.getElementById('pbs-sentinel');
      if (!sentinel) return;
      if (typeof IntersectionObserver !== 'function') {
        // Old browser fallback — keep behavior somewhat usable by
        // swapping the sentinel into a clickable "Load more" so the
        // vendor isn't stranded without scroll-triggered loading.
        sentinel.style.cursor = 'pointer';
        sentinel.onclick = function() { window._storeShowMore(); };
        return;
      }
      _storeObserver = new IntersectionObserver(function(entries) {
        if (!entries.some(function(e) { return e.isIntersecting; })) return;
        if (_storeObserver) { _storeObserver.disconnect(); _storeObserver = null; }
        _renderedCount += PAGE_SIZE;
        renderMyStore();
      }, { rootMargin: '600px 0px' });
      _storeObserver.observe(sentinel);
    } catch(e) {
      // Any observer failure shouldn't break the visible grid; the
      // sentinel just stops auto-loading.
      console.warn('[Store] scroll loader failed:', e);
    }
  }

  // Debounced search/sort handler — typing in #storeSearch fires
  // input on every keystroke, and a vendor with thousands of cards
  // rebuilding the grid 5+ times per keystroke locks mobile. The
  // 180ms debounce coalesces the keystrokes; sort changes go through
  // immediately since they're discrete clicks.
  let _storeRenderTimer = null;
  window._storeRenderDebounced = function() {
    _renderedCount = PAGE_SIZE; // reset on every new search
    if (_storeRenderTimer) clearTimeout(_storeRenderTimer);
    _storeRenderTimer = setTimeout(function() {
      _storeRenderTimer = null;
      renderMyStore();
    }, 180);
  };

  function _summaryTile(label, value, color) {
    return ''
      + '<div class="pbs-summary-tile">'
      +   '<div class="pbs-summary-label">' + _esc(label) + '</div>'
      +   '<div class="pbs-summary-value" style="color:' + color + '">' + _esc(value) + '</div>'
      + '</div>';
  }

  function _tileHtml(e) {
    const photo = e.card_image_url || '';
    const setLine = [e.set_name, e.card_number ? '#' + e.card_number : '']
      .filter(Boolean).join(' · ');
    const isListed = (e.listedQty > 0);
    const stockClass = e.onShelfQty === 0 ? ' is-empty'
                     : e.onShelfQty <= 2  ? ' is-low'
                     : '';
    const variantTag = (e.variant && e.variant !== 'normal')
      ? '<span class="pbs-variant">' + _esc(String(e.variant).replace(/_/g, ' ')) + '</span>'
      : '';
    const imgEl = photo
      ? '<img src="' + _esc(photo) + '" alt="" loading="lazy" decoding="async" '
        +    'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
      : '';
    const placeholder = '<div class="pbs-img-placeholder"'
      + (photo ? ' style="display:none"' : '') + '>?</div>';
    const priceOrUnlisted = isListed
      ? '<span class="pbs-price">$' + (e.listedValue || 0).toFixed(2) + '</span>'
      : '<span class="pbs-unlisted">UNLISTED</span>';
    const itemId = _escJsAttr(e.collection_item_id);
    // SOLD always available (disabled when nothing on shelf).
    // LIST shown only when the card isn't already listed. Plain text
    // labels — no $/+ glyphs — to keep the tile overlay clean.
    const soldBtn = '<button class="pbs-action-btn" title="Record in-store sale"'
      + (e.onShelfQty <= 0 ? ' disabled' : '')
      + ' onclick="event.stopPropagation();openMarkSoldModal(\'' + itemId + '\')">SOLD</button>';
    const listBtn = !isListed
      ? '<button class="pbs-action-btn is-list" title="List on marketplace" '
        + 'onclick="event.stopPropagation();_storeOpenListFor(\'' + itemId + '\')">LIST</button>'
      : '';
    return ''
      + '<div class="pbs-tile" onclick="openStoreCardDetail(\'' + itemId + '\')">'
      +   '<div class="pbs-tile-img-wrap">'
      +     imgEl + placeholder
      +     '<span class="pbs-stock' + stockClass + '">' + e.onShelfQty + '/' + e.totalQty + '</span>'
      +     priceOrUnlisted
      +     variantTag
      +     '<div class="pbs-actions">' + soldBtn + listBtn + '</div>'
      +   '</div>'
      +   '<div class="pbs-tile-body">'
      +     '<div class="pbs-tile-name">' + _esc(e.name) + '</div>'
      +     (setLine ? '<div class="pbs-tile-meta">' + _esc(setLine) + '</div>' : '')
      +   '</div>'
      + '</div>';
  }

  // ── Action dispatchers ──────────────────────────────────────────
  // Tap on a tile body opens the binder detail modal (rich detail
  // with TCGplayer + PriceCharting links).
  function openStoreCardDetail(itemId) {
    if (typeof openBinderCardDetail === 'function') {
      return openBinderCardDetail(itemId);
    }
  }

  // + LIST overlay button — open the list-card modal pre-filled with
  // the catalog metadata so the vendor doesn't have to re-enter the
  // name / number.
  function _storeOpenListFor(itemId) {
    const item = (collectionItems || []).find(function(c){ return String(c.id) === String(itemId); });
    if (!item) return;
    if (typeof openListCardModal !== 'function') return;
    openListCardModal({
      cardName:   item.card_name,
      gameType:   item.game_type || 'Pokémon',
      apiCardId:  item.api_card_id || '',
      cardNumber: item.card_number || '',
      variant:    item.variant || 'normal',
      condition:  item.condition === 'graded' ? 'Graded' : 'NM',
      productType: 'single',
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Expose to window ────────────────────────────────────────────
  window.renderMyStore = renderMyStore;
  window.openStoreCardDetail = openStoreCardDetail;
  window._storeOpenListFor   = _storeOpenListFor;
  window._invalidateStoreCache = function() { /* no cache to clear */ };

  console.log('[store] /pb-store.js loaded (inventory + listings merged)');
})();
