// =========================================================
// PathBinder — Avatar engine (lazy-loaded)
//
// Extracted from pb-app.js. The sprite-based avatar editor +
// renderer + cyberpunk palette. Exposes window.AvatarCreator
// as its only external surface. Lazy-loaded by pb-app.js on
// idle (so the PFP can render shortly after page load) OR on
// first call to a `window.AvatarCreator.*` method via the
// lazy-load stub in pb-app.js.
// =========================================================

// ── Block 9 ──────────────────────────────────────────
(() => {
  'use strict';

  // ── Sprite-based avatar engine ──────────────────────────────────────
  // Layered grayscale WebP sprites composited onto a single canvas,
  // tinted per-layer via `multiply` blend so swatch colors flow through
  // the highlights and shadows baked into each sprite. The previous
  // engine was ~1700 lines of procedural pixel-art (ctx.fillRect calls
  // for every garment); this version delegates rendering to actual art
  // assets which makes adding new sprites / unlockables a folder drop
  // instead of a code change.

  // Two-key state model:
  //   STORAGE_KEY  — the COMMITTED avatar (the one displayed as PFP /
  //                  synced to cloud). Only written by "Set as PFP".
  //   WORKING_KEY  — the in-editor working state, auto-saved on every
  //                  tweak so the user can come back without losing
  //                  progress. Never touched by cloud sync.
  // On first load: prefer WORKING (resume) → fall back to COMMITTED →
  // fall back to defaults.
  const STORAGE_KEY = 'pathbinder_avatar_v2';        // committed
  const WORKING_KEY = 'pathbinder_avatar_working_v1'; // in-editor draft
  const SPRITE_PATH = '/avatar/';
  const W = 182, H = 414;                       // matches sprite dimensions; canvas attrs in HTML match

  // ── Palettes — every category gets exactly 7 swatches so the UI is
  // consistent (7 presets + 1 custom picker = 8 columns per row).
  // Colors chosen to map clearly onto the avatar after tinting; brights
  // are picked over pastels so the multiply pass still reads as the
  // selected color rather than muddying out.
  const SKIN   = [
    '#FFE4C4',   // porcelain
    '#F4C29B',   // light tan
    '#D2956D',   // golden
    '#A6724A',   // medium brown
    '#7A4A28',   // warm brown
    '#4A2812',   // deep brown
    '#2A1408'    // very dark
  ];
  const EYE    = [
    '#3D2817',   // brown
    '#5B89C7',   // blue
    '#5BAA68',   // green
    '#9B59B6',   // violet
    '#D4A017',   // gold
    '#FF2A6D',   // cyber pink
    '#1AC7A0'    // electric cyan
  ];
  const HAIR_C = [
    '#1A1530',   // black
    '#3D2817',   // brown
    '#FFE38A',   // blonde
    '#FF2A6D',   // hot pink
    '#1AC7A0',   // electric cyan
    '#C8FF5C',   // acid green
    '#C9B4FF'    // lavender
  ];
  // ── Unified cyberpunk garment palette ────────────────────────────
  // Single 7-color set applied to every clothing slot (top, bottom,
  // shoes, hat) plus the custom picker as the 8th. Cyberpunk Y2K
  // mood: neon brights anchored by black, dropped white for accent.
  const CYBER_PALETTE = [
    '#1AC7A0',   // electric cyan       — PathBinder primary
    '#FF2A6D',   // hot magenta
    '#C8FF5C',   // acid lime
    '#FF6B35',   // sunset orange
    '#6F4FFF',   // electric violet
    '#FAF7E8',   // bone white
    '#1A1530'    // void black
  ];
  const CLOTH  = CYBER_PALETTE;
  const SHOE_C = CYBER_PALETTE;
  const HAT_C  = CYBER_PALETTE;

  // Bump these when you drop more sprites in /avatar/. UI options are
  // generated from these limits — no markup changes needed for new gear.
  const LIMITS = { hair: 19, hat: 4, top: 8, bottom: 3, shoes: 2 };

  // Default outfit: clothed (top + bottom + shoes), no hat, dark hair,
  // PathBinder cyan tee. No naked avatars; that was an explicit ask.
  const DEFAULT = {
    body: 'm',
    skin: '#F4C29B',
    eye: '#3D2817',
    hair: 1,         hairColor: '#1A1530',
    hat: 0,          hatColor:  '#FFB1CC',
    top: 1,          topColor:  '#6FF7E0',
    bottom: 1,       bottomColor: '#1A1530',
    shoes: 1,        shoesColor:  '#FAF7E8'
  };

  function _parseValid(raw) {
    try {
      const s = JSON.parse(raw);
      // Schema sanity-check: new shape uses body 'm'|'f'. Old procedural
      // saves used 'masc'|'femme' under the same v1 key — those get
      // ignored and the user starts fresh on first load of v2.
      if (s && typeof s === 'object' && (s.body === 'm' || s.body === 'f')) {
        return { ...DEFAULT, ...s };
      }
    } catch(_) {}
    return null;
  }
  function loadState() {
    // Resume from in-editor working draft first, then committed PFP,
    // then defaults. Working takes priority so a refresh mid-edit
    // doesn't lose user changes; the committed state still drives
    // the displayed PFP and cloud sync.
    const w = localStorage.getItem(WORKING_KEY);
    if (w) { const p = _parseValid(w); if (p) return p; }
    const c = localStorage.getItem(STORAGE_KEY);
    if (c) { const p = _parseValid(c); if (p) return p; }
    return { ...DEFAULT };
  }

  let state = loadState();

  const canvas = document.getElementById('av-canvas');
  if (!canvas) return;                          // page not in DOM — bail silently
  const ctx = canvas.getContext('2d');

  // Offscreen scratch canvas used for the tint pipeline. Doing the
  // sprite→multiply→destination-in dance on a separate canvas means
  // each layer composites cleanly onto the main canvas without the
  // multiply leaking outside the sprite's alpha mask.
  const tCanvas = document.createElement('canvas');
  tCanvas.width = W;
  tCanvas.height = H;
  // willReadFrequently:true tells the browser to keep the canvas backing
  // store in CPU memory — drawBodyTinted calls getImageData on every
  // render, and without this Chrome warns that the readback would be
  // faster with the flag set.
  const tCtx = tCanvas.getContext('2d', { willReadFrequently: true });

  // Sprite cache — URL → Promise<Image|null>. Resolves null on 404 so
  // missing assets render as a no-op rather than blocking the chain.
  const cache = new Map();
  function loadSprite(name) {
    if (cache.has(name)) return cache.get(name);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { console.warn('[avatar] missing sprite:', name); resolve(null); };
      img.src = SPRITE_PATH + name + '.webp';
    });
    cache.set(name, p);
    return p;
  }

  // Cel-shaded pixel tint. Single pipeline for every sprite type.
  //
  // Rules per pixel:
  //   1. alpha == 0           → leave transparent (no-op)
  //   2. grayscale < OUTLINE  → leave as-is (preserves dark line work)
  //   3. else                 → multiply grayscale by color (tint fill)
  //
  // Alpha is never forced — partial-alpha pixels keep their natural
  // value, so anti-aliased silhouette edges stay soft (no tinted halo
  // around hands/feet/head) and the body interior stays opaque because
  // the artist drew it as alpha=255 in skin areas.
  //
  // Outline preservation is the ears-stay-skin-color trick: ears
  // inside the hair sprite are outline-only (dark pixels around a
  // transparent interior). Their dark pixels stay dark regardless of
  // hair color, and the body's skin shows through their transparent
  // interior. Same trick keeps cel-shaded outlines on hats, clothes,
  // shoes from getting hair/cloth/shoe-color-tinted.
  const OUTLINE_THRESHOLD = 70;   // bumped from 50 — artist's clothing outlines were drawn at ~gray 60 and weren't being caught
  const WHITE_THRESHOLD   = 200;
  const DEFAULT_ALPHA_CUT = 40;

  // drawTinted — opts:
  //   outlineColor          tint outline pixels with this (else preserve gray)
  //   preserveWhites        skip tint for gray >= 200 (eye whites etc.)
  //   alphaCutoff           clear pixels with alpha < this (default 40)
  //   smooth                run 3x3 box blur on grayscale before tinting
  //                         — kills the pixel-grain "grit" on dark colors
  //                         that quantization alone couldn't smooth out
  function drawTinted(sprite, color, opts) {
    if (!sprite) return;
    opts = opts || {};
    tCtx.clearRect(0, 0, W, H);
    // When `color` is null (NO_TINT sprite like bald hair), we DON'T
    // early-return — we still need to apply alphaCutoff, hat mask, etc.
    // The tint loop below skips the multiply step when there's no color,
    // leaving pixels at their original grayscale.
    const hasColor = !!color;
    let cr = 0, cg = 0, cb = 0;
    if (hasColor) {
      const hex = color.charAt(0) === '#' ? color.slice(1) : color;
      cr = parseInt(hex.slice(0, 2), 16) || 0;
      cg = parseInt(hex.slice(2, 4), 16) || 0;
      cb = parseInt(hex.slice(4, 6), 16) || 0;
    }
    let or = 0, og = 0, ob = 0, hasOutlineColor = false;
    if (opts.outlineColor) {
      const oh = opts.outlineColor.charAt(0) === '#' ? opts.outlineColor.slice(1) : opts.outlineColor;
      or = parseInt(oh.slice(0, 2), 16) || 0;
      og = parseInt(oh.slice(2, 4), 16) || 0;
      ob = parseInt(oh.slice(4, 6), 16) || 0;
      hasOutlineColor = true;
    }
    const aCut = opts.alphaCutoff || DEFAULT_ALPHA_CUT;
    tCtx.globalCompositeOperation = 'source-over';
    tCtx.drawImage(sprite, 0, 0);
    const id = tCtx.getImageData(0, 0, W, H);
    const d = id.data;

    // ── Tint pass ──────────────────────────────────────────────────
    // Two tinting formulas:
    //  - hard multiply (default): result = gray × color / 255.
    //      Used for skin/hair/eyes where standard multiply looks right.
    //  - softShade (opts.softShade=true): cel-shade the shadow band,
    //      smooth-multiply everything else. The shadow range (gray 50
    //      to 149) is the source of the visible "grit" — it lives in
    //      dark RGB territory where the eye is sensitive to small
    //      brightness changes, and any pixel-to-pixel variation in the
    //      sprite's grayscale shows as noise after the multiply.
    //      Snapping shadow pixels to a few discrete tones (75 and 125)
    //      makes every shadow pixel within a band identical → zero
    //      variation → zero grit, while keeping shadows clearly
    //      visible. Base/highlight gradients (gray 150+) stay on
    //      smooth multiply because the user said those already look
    //      great.
    const softShade = !!opts.softShade;
    const aOutThr = opts.alphaOutlineThreshold || 0;
    // Per-layer outline gray threshold. Defaults to the global
    // OUTLINE_THRESHOLD (70) but layers like hair pass a lower value
    // (~20) because their dark fill pixels otherwise get mis-classified
    // as outlines and tinted with skin instead of the hair color.
    const oThr = opts.outlineThreshold != null ? opts.outlineThreshold : OUTLINE_THRESHOLD;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      if (a < aCut) { d[i + 3] = 0; continue; }
      const g = d[i];
      // Outline-style treatment if (a) grayscale is low OR (b) alpha
      // is below the alphaOutlineThreshold. The second case catches
      // semi-transparent pixels (anti-aliased hair edges, soft ear
      // detail) so they get skin-tinted instead of hair-tinted —
      // those pixels blend into the body instead of carrying garish
      // hair color at low opacity.
      if ((g < oThr && !opts.skipOutlines) || (aOutThr && a < aOutThr)) {
        if (hasOutlineColor) {
          d[i]     = (g * or) >> 8;
          d[i + 1] = (g * og) >> 8;
          d[i + 2] = (g * ob) >> 8;
        }
        continue;
      }
      if (opts.preserveWhites && g >= (opts.whiteThreshold || WHITE_THRESHOLD)) continue;
      // softShade uses lifted multiply: factor = 0.4 + 0.6×(gray/255).
      // Shadows compress to 40-60% of color brightness, base color
      // (gray 255) stays at full color. Smooth gradient, no hard
      // cel-shade bands. Restores the depth that was lost when we
      // stopped preserving outlines (since outlines no longer provide
      // the dark anchor, shadows need to do the structural work).
      if (!hasColor) continue;     // NO_TINT sprite — leave grayscale
      if (softShade) {
        // Lifted multiply: factor = floor + (1-floor) × (gray/255)
        // floor=0 → pure multiply (darkest, used for clothing)
        // floor=0.6 → bright/saturated (used for eyes — keeps iris
        //             close to the picked color instead of multiplying
        //             down into dim territory)
        const sf = opts.softFloor || 0;
        const f = sf + (1 - sf) * (g / 255);
        d[i]     = (cr * f) | 0;
        d[i + 1] = (cg * f) | 0;
        d[i + 2] = (cb * f) | 0;
      } else {
        d[i]     = (g * cr) >> 8;
        d[i + 1] = (g * cg) >> 8;
        d[i + 2] = (g * cb) >> 8;
      }
    }

    // ── Hat mask (hair only) ───────────────────────────────────────
    // Per-pixel hat region mask. Where the mask is 1, clear the
    // hair pixel's alpha — hat will draw over those positions. The
    // mask was dilated outward in render() so it extends a few
    // pixels past the hat's actual silhouette, catching hair that
    // would otherwise peek out along the hat's anti-aliased edge.
    // Hat's intentionally-transparent areas (cutouts, holes) never
    // enter the mask, so hair beneath them still shows.
    if (opts.hatMask) {
      const mask = opts.hatMask;
      const N = W * H;
      for (let i = 0; i < N; i++) {
        if (mask[i]) d[i * 4 + 3] = 0;
      }
    }

    tCtx.putImageData(id, 0, 0);
    ctx.drawImage(tCanvas, 0, 0);
  }

  // Gamma LUT (precomputed) — body tint applies gamma 1.4 to push
  // shadow tones deeper. Pure multiply (gamma 1.0) was the previous
  // behavior; gamma 1.4 darkens mid-grays (gray 100 maps to ~30%
  // instead of 39%) without touching pure white. Built once at
  // module init so the inner loop is just a table lookup.
  const BODY_GAMMA_LUT = (() => {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.round(Math.pow(i / 255, 1.4) * 255);
    }
    return lut;
  })();

  // Body uses the same outline+alpha-preservation pipeline, plus two
  // extra rules:
  //   1. pixels already mostly opaque (alpha > 200) get forced to 255
  //      so interior skin stays solid against the dark stage
  //   2. fill pixels go through the gamma LUT before multiplying with
  //      the skin color, deepening shadows beyond plain multiply
  function drawBodyTinted(sprite, color) {
    if (!sprite) return;
    tCtx.clearRect(0, 0, W, H);
    if (!color) {
      tCtx.globalCompositeOperation = 'source-over';
      tCtx.drawImage(sprite, 0, 0);
      ctx.drawImage(tCanvas, 0, 0);
      return;
    }
    const hex = color.charAt(0) === '#' ? color.slice(1) : color;
    const cr = parseInt(hex.slice(0, 2), 16) || 0;
    const cg = parseInt(hex.slice(2, 4), 16) || 0;
    const cb = parseInt(hex.slice(4, 6), 16) || 0;
    tCtx.globalCompositeOperation = 'source-over';
    tCtx.drawImage(sprite, 0, 0);
    const id = tCtx.getImageData(0, 0, W, H);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      if (a < 40) { d[i + 3] = 0; continue; }
      const g = d[i];
      if (g >= OUTLINE_THRESHOLD) {
        // Fill — apply gamma to push shadows deeper, then tint
        const gg = BODY_GAMMA_LUT[g];
        d[i]     = (gg * cr) >> 8;
        d[i + 1] = (gg * cg) >> 8;
        d[i + 2] = (gg * cb) >> 8;
      } else {
        // Outline — force pure black instead of preserving artist's gray.
        d[i]     = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
      }
      if (a > 200) d[i + 3] = 255;
    }
    tCtx.putImageData(id, 0, 0);
    ctx.drawImage(tCanvas, 0, 0);
  }

  // Sprite indices that don't take a color tint. The bald-with-ears
  // hair sprite (index 7) is grayscale-only — tinting paints the ears
  // weird colors, which the user (rightly) doesn't want.
  const NO_TINT = {
    hair: new Set([7])
  };
  function tintFor(category, idx, color) {
    if (NO_TINT[category] && NO_TINT[category].has(idx)) return null;
    return color;
  }

  // Render order (back→front): body, eyes, bottom, shoes, top, hair, hat.
  // A render token guards against stale completions when state changes
  // mid-load — only the most recent render call actually paints.
  let renderToken = 0;
  async function render() {
    const myToken = ++renderToken;
    const body = state.body;
    // Each layer carries an options object so per-sprite tweaks stay
    // readable. Defaults shown in the helper below; only override what
    // matters for that layer.
    const bodyFile = body === 'm' ? 'male' : 'female';
    const layer = (name, color, opts) => ({ name, color, opts: opts || {} });
    const layers = [];
    layers.push(layer(bodyFile,         state.skin,                                                          { isBody: true }));
    // Eyes (both m and f): preserveWhites with tight threshold (235)
    // so the artist's true whites (sclera + reflection dots) stay
    // bright. Soft-shade with floor 0.6 keeps the iris close to the
    // picked color instead of multiplying down into dark territory.
    layers.push(layer('eyes_' + body,   state.eye,                                                           { preserveWhites: true, whiteThreshold: 235, softShade: true, softFloor: 0.6 }));
    if (state.bottom) layers.push(layer(`bottom${state.bottom}_${body}`, tintFor('bottom', state.bottom, state.bottomColor), { softShade: true, skipOutlines: true }));
    if (state.shoes)  layers.push(layer(`shoes${state.shoes}_${body}`,   tintFor('shoes',  state.shoes,  state.shoesColor),  { softShade: true, skipOutlines: true }));
    // Top sprites 6 + 7 are the PathBinder graphic tees — they have
    // intentional dark line work that needs preserving (logo outlines,
    // crest detail). Other tops are skipOutlines because their outlines
    // were the source of the visual issue earlier.
    if (state.top) {
      const preserveTopOutlines = state.top === 6 || state.top === 7;
      layers.push(layer(`top${state.top}_${body}`, tintFor('top', state.top, state.topColor), { softShade: true, skipOutlines: !preserveTopOutlines }));
    }
    // Hair: outline pixels (gray < 70) get tinted with skin color so
    // the dark ear outlines blend into the body line work. Semi-
    // transparent pixels now tint normally with hair color — the
    // "skin-tinted soft pixels" trick made the hair itself look
    // weird and there's no clean way to fix the ears without
    // breaking the hair, so we accept the trade-off.
    // Bald (hair 7) gets a higher alphaCutoff because its semi-
    // transparent ear cartilage rendered as noisy speckle.
    if (state.hair) {
      // outlineThreshold dropped to 20 (from default 70) — many of our
      // hair sprites have most of their fill drawn at gray 30-60, which
      // was being mis-classified as "outline" and tinted with skin
      // instead of the picked hair color. Result: dark hairstyles only
      // showed the new color on the lightest anti-aliased pixels. With
      // threshold 20, only the artist's true near-black outline strokes
      // get skin-tinted; the dark fill pixels now receive the hair tint.
      const hairOpts = state.hair === 7
        ? { outlineColor: state.skin, alphaCutoff: 200, outlineThreshold: 20 }
        : { outlineColor: state.skin, alphaCutoff: 60,  outlineThreshold: 20 };
      layers.push(layer(`hair${state.hair}_${body}`, tintFor('hair', state.hair, state.hairColor), hairOpts));
    }
    if (state.hat)    layers.push(layer(`hat${state.hat}_${body}`,       tintFor('hat',    state.hat,    state.hatColor),    { softShade: true, skipOutlines: true }));

    const sprites = await Promise.all(layers.map(l => loadSprite(l.name)));
    if (myToken !== renderToken) return;

    // Build a per-column "hat bottom" array so the hair layer can hide
    // any pixel above where the hat sits. Without this, hair pokes
    // through any transparent gaps in the hat sprite (and any hair
    // sized too tall for the hat overhangs out the top). With this
    // mask, the hat appears to "compress" the hair — hair above the
    // hat's bottom edge is cleared per-column.
    let hatBottomCol = null;
    let hatLayerIdx = -1;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].name.indexOf('hat') === 0 && sprites[i]) {
        hatLayerIdx = i;
        break;
      }
    }
    // Hair styles that need EXTRA WIDE hat mask coverage — wide
    // pigtails / buns / volume on the sides that would peek out past
    // the hat without sideways dilation.
    const HAIR_WIDE_HAT_MASK = new Set([3, 4, 5, 8, 10, 11, 12, 13, 15, 17]);
    const wideHatMask = state.hair && HAIR_WIDE_HAT_MASK.has(state.hair);
    // 45° diagonal extension down-and-outward from the forehead.
    // Now keyed off the HAT (not the hair) — applied for any hat
    // EXCEPT hat3 (the bucket hat), whose wide brim already covers
    // the area naturally. Runs symmetrically on both halves of the
    // canvas so hair on either side stays under the hat.
    const BUCKET_HAT_IDX = 3;
    const diagonalHatMask = state.hat && state.hat !== BUCKET_HAT_IDX;

    if (hatLayerIdx >= 0) {
      // Hat mask construction — three combined passes:
      //   1. Mark hat opaque pixels.
      //   2. Flood-fill exterior from canvas corners (transparent
      //      pixels reachable from the edge). Anything transparent
      //      but NOT exterior is an interior hole in the hat (e.g.
      //      hat 2's cutout) — leave those alone.
      //   3. Dilate the opaque mask outward, BUT only into exterior
      //      pixels. Interior holes stay un-masked → hair shows
      //      through them.
      //   4. Per-column "above hat top" pass — for each column with
      //      hat content, mark every pixel above the topmost opaque
      //      row. Catches tall hair sticking up past the hat that
      //      dilation alone wouldn't reach.
      tCtx.clearRect(0, 0, W, H);
      tCtx.globalCompositeOperation = 'source-over';
      tCtx.drawImage(sprites[hatLayerIdx], 0, 0);
      const hd = tCtx.getImageData(0, 0, W, H).data;
      const N = W * H;
      const HAT_ALPHA_MIN = 10;
      const DILATE_PX = 10;

      // Pass 1 — opaque mask
      hatBottomCol = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (hd[i * 4 + 3] > HAT_ALPHA_MIN) hatBottomCol[i] = 1;
      }

      // Pass 2 — exterior via flood fill from canvas corners
      const exterior = new Uint8Array(N);
      const stack = [];
      const seedExt = (idx) => {
        if (!exterior[idx] && hd[idx * 4 + 3] <= HAT_ALPHA_MIN) {
          exterior[idx] = 1;
          stack.push(idx);
        }
      };
      for (let x = 0; x < W; x++) { seedExt(x); seedExt((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { seedExt(y * W); seedExt(y * W + W - 1); }
      while (stack.length) {
        const i = stack.pop();
        const x = i % W, y = (i / W) | 0;
        if (x > 0)     seedExt(i - 1);
        if (x < W - 1) seedExt(i + 1);
        if (y > 0)     seedExt(i - W);
        if (y < H - 1) seedExt(i + W);
      }

      // Pass 3 — vertical-only dilation. Only check "is the pixel
      // below me masked?" → grows mask upward N rows per column.
      // No sideways propagation, so a curved brim doesn't carry its
      // lowest Y into adjacent columns. The cut follows the actual
      // hat silhouette per column instead of a horizontal line at
      // the brim's deepest point.
      const tmp = new Uint8Array(N);
      for (let iter = 0; iter < DILATE_PX; iter++) {
        tmp.set(hatBottomCol);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (hatBottomCol[i]) continue;
            if (!exterior[i]) continue;
            if (y < H - 1 && hatBottomCol[i + W]) {   // pixel below me is masked → grow UP
              tmp[i] = 1;
            }
          }
        }
        hatBottomCol.set(tmp);
      }

      // Pass 4 — per-column "above hat top" → catches tall hair that
      // would otherwise poke out the top of the hat.
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          if (hd[(y * W + x) * 4 + 3] > HAT_ALPHA_MIN) {
            for (let yy = 0; yy < y; yy++) hatBottomCol[yy * W + x] = 1;
            break;
          }
        }
      }

      // Pass 5 — shave 1 px off the bottom of the mask per column.
      // Stops the hat's bottom edge from biting into hair right
      // underneath it (forehead / hair-line area).
      for (let x = 0; x < W; x++) {
        for (let y = H - 1; y >= 0; y--) {
          if (hatBottomCol[y * W + x]) {
            hatBottomCol[y * W + x] = 0;
            break;
          }
        }
      }

      // Pass 6 — (optional) sideways dilation for wide-coverage hair
      // styles. For pigtails/buns/wide hair, the mask grows N pixels
      // left and right at every Y where the mask exists.
      if (wideHatMask) {
        const SIDE_DILATE_PX = 12;
        for (let iter = 0; iter < SIDE_DILATE_PX; iter++) {
          tmp.set(hatBottomCol);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = y * W + x;
              if (hatBottomCol[i]) continue;
              if (!exterior[i]) continue;     // never grow into interior holes
              if ((x > 0     && hatBottomCol[i - 1]) ||
                  (x < W - 1 && hatBottomCol[i + 1])) {
                tmp[i] = 1;
              }
            }
          }
          hatBottomCol.set(tmp);
        }
      }

      // Pass 6.5 — 45° diagonal extension. Runs symmetrically on
      // both halves of the canvas: on the right half the mask grows
      // down-and-right from any up-and-left neighbor; on the left
      // half it grows down-and-left from any up-and-right neighbor.
      // Result: hat mask widens at 45° as it descends, catching hair
      // that would otherwise peek out from under the hat sides.
      if (diagonalHatMask) {
        const DIAG_ITER = 30;
        const CX = W >> 1;
        for (let iter = 0; iter < DIAG_ITER; iter++) {
          tmp.set(hatBottomCol);
          for (let y = 1; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = y * W + x;
              if (hatBottomCol[i]) continue;
              if (!exterior[i]) continue;
              if (x >= CX) {
                // Right half — pull from up-and-left neighbor.
                if (x > 0 && hatBottomCol[(y - 1) * W + (x - 1)]) {
                  tmp[i] = 1;
                }
              } else {
                // Left half — pull from up-and-right neighbor.
                if (x < W - 1 && hatBottomCol[(y - 1) * W + (x + 1)]) {
                  tmp[i] = 1;
                }
              }
            }
          }
          hatBottomCol.set(tmp);
        }
      }

      // Pass 7 — explicitly unmask interior hole pixels. Any
      // transparent pixel that's NOT exterior (not reachable from
      // canvas edges) is an interior hole in the hat (e.g. hat 2's
      // cutout). Force those pixels off-mask so hair shows through.
      for (let i = 0; i < N; i++) {
        if (!exterior[i] && hd[i * 4 + 3] <= HAT_ALPHA_MIN) {
          hatBottomCol[i] = 0;
        }
      }
    }

    // Hair styles that should NOT get clipped by the hat mask — long
    // or flowy hair that intentionally extends past where the hat sits.
    const HAIR_IGNORE_HAT_MASK = new Set([6, 9]);

    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < layers.length; i++) {
      const { name, color, opts } = layers[i];
      // Attach the hat top-edge mask to the hair layer so drawTinted
      // can clear hair pixels above the hat per-column. Skip when the
      // active hairstyle is in HAIR_IGNORE_HAT_MASK.
      const shouldMaskHair =
        hatBottomCol &&
        name.indexOf('hair') === 0 &&
        !HAIR_IGNORE_HAT_MASK.has(state.hair);
      const renderOpts = shouldMaskHair
        ? Object.assign({}, opts, { hatMask: hatBottomCol })
        : opts;
      if (renderOpts.isBody) {
        drawBodyTinted(sprites[i], color);
      } else {
        drawTinted(sprites[i], color, renderOpts);
      }
    }
  }

  // saveWorking — local-only, fires on every tweak so the user's
  // in-progress edits survive a refresh. Does NOT sync to cloud and
  // does NOT update the committed PFP.
  function saveWorking() {
    try { localStorage.setItem(WORKING_KEY, JSON.stringify(state)); } catch(_) {}
  }
  // commitState — "Set as PFP" path. Promotes the working state to
  // the committed slot, drops the working draft (so the editor
  // re-opens to the freshly-committed avatar), and syncs to cloud.
  function commitState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(_) {}
    try { localStorage.removeItem(WORKING_KEY); } catch(_) {}
    try { if (typeof syncUserDataToCloud === 'function') syncUserDataToCloud(); } catch(_) {}
  }
  // Back-compat shim for any external caller that still references saveState
  function saveState() { commitState(); }

  // ── UI construction ──────────────────────────────────────────────────
  // Sprite categories generate their own buttons from LIMITS. Body and
  // 'NONE' for hair/hat are special-cased.
  function buildOpts(category, count, allowNone, noneLabel) {
    const container = document.querySelector(`#av-controls .av-opts[data-avkey="${category}"]`);
    if (!container) return;
    container.innerHTML = '';
    if (allowNone) {
      const b = document.createElement('button');
      b.className = 'av-opt';
      b.dataset.val = '0';
      b.textContent = noneLabel || 'NONE';
      container.appendChild(b);
    }
    for (let i = 1; i <= count; i++) {
      const b = document.createElement('button');
      b.className = 'av-opt';
      b.dataset.val = String(i);
      b.textContent = String(i);
      container.appendChild(b);
    }
  }

  // Compute approx rendered color for a swatch — applies the same
  // tint math the avatar uses, so the swatch visually matches what
  // the user will see on the body. Without this, bright source
  // colors looked very different on the avatar (the multiply pass
  // darkens them) and users couldn't tell which swatch produces
  // which result.
  function _swatchPreviewColor(srcColor, stateKey) {
    const hex = srcColor.charAt(0) === '#' ? srcColor.slice(1) : srcColor;
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    const REF_GRAY = 220;     // typical "main color" pixel in sprites
    let factor;
    if (stateKey === 'skin') {
      // Body uses gamma 1.4 curve
      factor = Math.pow(REF_GRAY / 255, 1.4);
    } else if (stateKey === 'eye') {
      // Eye uses softFloor 0.6
      factor = 0.6 + 0.4 * (REF_GRAY / 255);
    } else {
      // Hair / clothing — pure multiply
      factor = REF_GRAY / 255;
    }
    const pr = Math.round(r * factor);
    const pg = Math.round(g * factor);
    const pb = Math.round(b * factor);
    return 'rgb(' + pr + ',' + pg + ',' + pb + ')';
  }
  function buildSwatches(containerId, palette, stateKey) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    palette.forEach(color => {
      const s = document.createElement('div');
      s.className = 'av-sw';
      s.style.background = _swatchPreviewColor(color, stateKey);
      s.dataset.color = color;
      s.addEventListener('click', () => {
        state[stateKey] = color;
        syncUI();
        render();
        saveWorking();
      });
      c.appendChild(s);
    });
    // Custom color picker — opens the platform-native color wheel.
    // Lets users pick any hex value while keeping presets for quick
    // common choices. Hidden <input type="color"> with a styled trigger
    // so we can match the swatch aesthetic instead of showing the raw
    // browser-chrome color rectangle.
    const customWrap = document.createElement('div');
    customWrap.className = 'av-sw av-sw-custom';
    customWrap.title = 'Custom color';
    customWrap.style.background = 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
    customWrap.style.position = 'relative';
    customWrap.dataset.stateKey = stateKey;
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = (state[stateKey] || '#ffffff').slice(0, 7);
    picker.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0';
    picker.addEventListener('input', (e) => {
      state[stateKey] = e.target.value;
      syncUI();
      render();
    });
    picker.addEventListener('change', () => {
      // Commit on change (when picker closes) — input fires constantly
      // while user drags, but we only persist on the final value.
      saveWorking();
    });
    customWrap.appendChild(picker);
    c.appendChild(customWrap);
  }

  function syncUI() {
    // Highlight active option button per category
    document.querySelectorAll('#av-controls .av-opts').forEach(container => {
      const key = container.dataset.avkey;
      const val = state[key];
      container.querySelectorAll('.av-opt').forEach(btn => {
        const v = btn.dataset.val;
        const match = (key === 'body') ? (v === val) : (String(val) === v);
        btn.classList.toggle('active', match);
      });
    });
    // Highlight active color swatch per category
    const swatchMap = {
      'av-sw-skin':   'skin',
      'av-sw-eye':    'eye',
      'av-sw-hair':   'hairColor',
      'av-sw-hat':    'hatColor',
      'av-sw-top':    'topColor',
      'av-sw-bottom': 'bottomColor',
      'av-sw-shoes':  'shoesColor'
    };
    Object.keys(swatchMap).forEach(id => {
      const stateKey = swatchMap[id];
      const c = document.getElementById(id);
      if (!c) return;
      c.querySelectorAll('.av-sw').forEach(s => {
        // Custom-picker swatch doesn't get the active highlight (it
        // represents "anything else"). It just gets its inner input
        // value synced so opening it shows the current color.
        if (s.classList.contains('av-sw-custom')) {
          const picker = s.querySelector('input[type="color"]');
          if (picker) picker.value = (state[stateKey] || '#ffffff').slice(0, 7);
        } else {
          s.classList.toggle('active', s.dataset.color === state[stateKey]);
        }
      });
    });
    // Hide color row entirely for color-locked sprites (e.g. bald hair).
    // Walks each category's COLOR label + swatch container and toggles
    // visibility based on NO_TINT membership of the current selection.
    const colorRowMap = {
      hair: 'av-sw-hair',
      hat:  'av-sw-hat',
      top:  'av-sw-top',
      bottom: 'av-sw-bottom',
      shoes: 'av-sw-shoes'
    };
    Object.keys(colorRowMap).forEach(category => {
      const idx = state[category];
      const isLocked = idx && NO_TINT[category] && NO_TINT[category].has(idx);
      const swatchEl = document.getElementById(colorRowMap[category]);
      if (!swatchEl) return;
      // The COLOR mini-label is the previous sibling of the swatches.
      const labelEl = swatchEl.previousElementSibling;
      swatchEl.style.display = isLocked ? 'none' : '';
      if (labelEl && labelEl.classList.contains('av-mini-lbl')) {
        labelEl.style.display = isLocked ? 'none' : '';
      }
    });
  }

  function init() {
    // Generate option buttons. Hair must always have one selected
    // because the ear silhouette is part of each hair sprite (the body
    // sprite has no ears). Hair index 7 is the "bald with ears" variant
    // — selecting it gives the bald look. Hat is genuinely optional.
    buildOpts('hair',   LIMITS.hair,   false);
    buildOpts('hat',    LIMITS.hat,    true, 'NONE');
    buildOpts('top',    LIMITS.top,    false);
    buildOpts('bottom', LIMITS.bottom, false);
    buildOpts('shoes',  LIMITS.shoes,  false);

    // Build color swatches
    buildSwatches('av-sw-skin',   SKIN,   'skin');
    buildSwatches('av-sw-eye',    EYE,    'eye');
    buildSwatches('av-sw-hair',   HAIR_C, 'hairColor');
    buildSwatches('av-sw-hat',    HAT_C,  'hatColor');
    buildSwatches('av-sw-top',    CLOTH,  'topColor');
    buildSwatches('av-sw-bottom', CLOTH,  'bottomColor');
    buildSwatches('av-sw-shoes',  SHOE_C, 'shoesColor');

    // Option click → state update (event delegation per category)
    document.querySelectorAll('#av-controls .av-opts').forEach(container => {
      const key = container.dataset.avkey;
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('.av-opt');
        if (!btn) return;
        let val = btn.dataset.val;
        if (key !== 'body') val = parseInt(val, 10);
        state[key] = val;
        syncUI();
        render();
        saveWorking();
      });
    });

    // Tab switching
    document.querySelectorAll('#avCatTabs .av-cat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#avCatTabs .av-cat-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const cat = tab.dataset.avcat;
        document.querySelectorAll('#av-controls .av-group').forEach(g => {
          g.classList.toggle('active', g.dataset.avgrp === cat);
        });
      });
    });

    // Randomize — picks within limits, always returns a clothed avatar
    const rndBtn = document.getElementById('av-randomize');
    if (rndBtn) {
      rndBtn.addEventListener('click', () => {
        const pick = arr => arr[Math.floor(Math.random() * arr.length)];
        const range = (n, allowZero) => {
          const min = allowZero ? 0 : 1;
          return Math.floor(Math.random() * (n - min + 1)) + min;
        };
        state = {
          body: pick(['m','f']),
          skin: pick(SKIN),
          eye:  pick(EYE),
          hair: range(LIMITS.hair, false),
          hairColor: pick(HAIR_C),
          hat: range(LIMITS.hat, true),
          hatColor: pick(HAT_C),
          top: range(LIMITS.top, false),
          topColor: pick(CLOTH),
          bottom: range(LIMITS.bottom, false),
          bottomColor: pick(CLOTH),
          shoes: range(LIMITS.shoes, false),
          shoesColor: pick(SHOE_C)
        };
        syncUI();
        render();
        saveWorking();
      });
    }

    // SET AS PFP — two writes:
    //   1. Save the rendered PNG to localStorage at the legacy key
    //      `pathbinder_avatar_pfp_v1` so the existing chips (sidebar,
    //      top nav, mobile, dropdown) pick it up as a backgroundImage.
    //   2. Sync the avatar_state JSON to Supabase via syncUserDataToCloud
    //      so the same avatar can be re-rendered on any device.
    // The earlier version tried to write the 50-200KB data URL into
    // avatar_url which 400'd because of column length constraints.
    // Guests get a download instead.
    const exportBtn = document.getElementById('av-exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        await new Promise(r => setTimeout(r, 80));   // wait for any in-flight render
        const dataUrl = canvas.toDataURL('image/png');
        if (typeof currentUser !== 'undefined' && currentUser && typeof sb !== 'undefined') {
          try {
            // commitState() copies working → committed, drops the
            // working draft, and syncs the committed state to cloud.
            commitState();
            try { localStorage.setItem('pathbinder_avatar_pfp_v1', dataUrl); } catch(_) {}
            // Refresh the on-screen PFP chips immediately
            if (typeof updateAuthUI === 'function') updateAuthUI();
            if (typeof showToast === 'function') showToast('PFP updated');
          } catch (e) {
            console.error('[avatar] PFP save failed', e);
            if (typeof showToast === 'function') showToast('PFP save failed');
          }
        } else {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = 'pathbinder-avatar.png';
          a.click();
        }
        const orig = exportBtn.textContent;
        exportBtn.textContent = '✓ SAVED!';
        setTimeout(() => { exportBtn.textContent = orig; }, 1600);
      });
    }

    syncUI();
    render();
  }

  init();

  // Public API — preserves the contract the rest of the app expects so
  // existing call sites (cloud sync, profile display) keep working.
  window.AvatarCreator = {
    getState: () => ({ ...state }),
    setState: (s) => {
      // Only accept state matching the new schema. Cloud sync might
      // still send old-schema blobs from before v2; those get ignored
      // and the user keeps whatever they currently have locally.
      if (s && typeof s === 'object' && (s.body === 'm' || s.body === 'f')) {
        state = { ...DEFAULT, ...s };
        syncUI();
        return render();
      }
      return Promise.resolve();
    },
    render: () => render(),
    // Force-reload from the COMMITTED PFP state and discard any
    // in-progress working draft. Useful if we want to add a "Reset
    // to current PFP" button later. Not called from showPage anymore
    // — opening the editor now resumes from the working draft so
    // user progress isn't lost.
    reloadFromCommitted: () => {
      try { localStorage.removeItem(WORKING_KEY); } catch(_) {}
      const c = localStorage.getItem(STORAGE_KEY);
      const parsed = c ? _parseValid(c) : null;
      state = parsed || { ...DEFAULT };
      syncUI();
      return render();
    },
    getDataURL: () => canvas.toDataURL('image/png'),
    // Render the current in-memory state and persist as the PFP PNG.
    refreshPfp: async () => {
      try {
        await render();
        const dataUrl = canvas.toDataURL('image/png');
        try { localStorage.setItem('pathbinder_avatar_pfp_v1', dataUrl); } catch(_) {}
        return dataUrl;
      } catch(_) { return null; }
    },
    // Render an arbitrary state (e.g. the cloud's committed avatar)
    // to a PNG and save as the PFP, WITHOUT disturbing whatever the
    // user has in the editor. Used by syncUserDataFromCloud so a
    // fresh browser regenerates the PFP image without overwriting
    // any in-progress working draft.
    renderCommittedToPfp: async (s) => {
      if (!s || typeof s !== 'object') return null;
      if (s.body !== 'm' && s.body !== 'f') return null;
      // Save current in-memory state, render committed, capture, restore.
      const saved = { ...state };
      state = { ...DEFAULT, ...s };
      try {
        await render();
        const dataUrl = canvas.toDataURL('image/png');
        try { localStorage.setItem('pathbinder_avatar_pfp_v1', dataUrl); } catch(_) {}
        state = saved;
        // Re-paint the canvas to whatever the editor was showing.
        await render();
        return dataUrl;
      } catch(_) {
        state = saved;
        return null;
      }
    },
    reset: () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
      state = { ...DEFAULT };
      syncUI();
      return render();
    }
  };
})();

