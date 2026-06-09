// =========================================================
// PathBinder — Scanner subsystem (lazy-loaded)
//
// Extracted from pb-app.js to keep the initial bundle smaller.
// Loaded on demand the first time the user opens any scanner
// entry point, OR prefetched at browser idle (whichever first).
// Once loaded, the entry-point window functions defined below
// OVERWRITE the lazy-load stubs sitting in pb-app.js.
// =========================================================

    function _setProcessingText(el, msg) {
      if (!el) return;
      const existing = _processingTimers.get(el);
      if (existing) { clearInterval(existing); _processingTimers.delete(el); }
      const isProgress = /(?:…|\.{2,3})\s*$/.test(msg);
      if (!isProgress) { el.textContent = msg; return; }
      const base   = msg.replace(/(?:…|\.{2,})\s*$/, '').trim();
      // Pad each frame to the same width so the text doesn't wobble as
      // the dots cycle. " .  " / " .. " / " ...".
      const frames = [' .  ', ' .. ', ' ...'];
      let i = 0;
      const tick = () => { el.textContent = base + frames[i]; i = (i + 1) % frames.length; };
      tick();
      _processingTimers.set(el, setInterval(tick, 320));
    }

    function setScanStatus(msg) {
      _setProcessingText(document.getElementById('scannerStatus'), msg);
    }

    // Called directly from the "Scan a Card" label on the Add Card page.
    // Opens the results sheet and kicks off the match pipeline.
    // ─── Add Card overlay ───────────────────────────────────────
    // Pops the existing pdex-themed addCardPage on top of whatever
    // page the user was on (binder by default). No route change —
    // close to return to context. Keyboard: Esc closes.
    function openAddCardOverlay() {
      const page = document.getElementById('addCardPage');
      if (!page) return;
      page.classList.add('active', 'pb-overlay');
      document.body.classList.add('pb-addcard-overlay');
      // Inject the close button if it's not already there.
      if (!document.querySelector('.pb-addcard-overlay-close')) {
        const btn = document.createElement('button');
        btn.className = 'pb-addcard-overlay-close';
        btn.innerHTML = '×';
        btn.setAttribute('aria-label', 'Close');
        btn.onclick = closeAddCardOverlay;
        document.body.appendChild(btn);
      }
      // Esc-to-close handler — bind once, but the body class gate
      // makes it a no-op when the overlay isn't open.
      if (!window._addCardEscWired) {
        window._addCardEscWired = true;
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && document.body.classList.contains('pb-addcard-overlay')) {
            closeAddCardOverlay();
          }
        });
      }
      // Refresh any "active" highlighting since we're not actually on
      // the addCard route.
      if (typeof setMobileNav === 'function') {
        try { setMobileNav('collection'); } catch(_) {}
      }
    }
    function closeAddCardOverlay() {
      const page = document.getElementById('addCardPage');
      if (page) page.classList.remove('active', 'pb-overlay');
      document.body.classList.remove('pb-addcard-overlay');
      const btn = document.querySelector('.pb-addcard-overlay-close');
      if (btn) btn.remove();
    }

    // ─── Scan Card nav action ───────────────────────────────────
    // Replaces what used to be the "Add Card" nav slot — opens a file
    // picker (camera on mobile) directly, kicking off the scanner
    // flow without dropping the user into the full Add Card UI. The
    // existing scanFromAddCard handles result rendering + the
    // openCardScanner modal, which works independently of whether
    // the addCard page is visible.
    function openScanCard() {
      if (!currentUser) { openModal('loginModal'); return; }
      let input = document.getElementById('navScanCardInput');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'navScanCardInput';
        input.accept = 'image/*';
        input.setAttribute('capture', 'environment');
        input.style.display = 'none';
        input.addEventListener('change', function() { scanFromAddCard(this); });
        document.body.appendChild(input);
      }
      input.click();
    }

    function scanFromAddCard(input) {
      const file = input.files[0];
      if (!file) return;
      input.value = '';
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataURL = e.target.result;
        // Show sheet immediately so user sees progress
        openCardScanner();
        // Show thumbnail
        const preview = document.getElementById('uploadPreview');
        if (preview) { preview.style.display = 'block'; preview.src = dataURL; }
        window._lastScanDataURL = dataURL; // offer as card photo on confirm
        setScanStatus('Scanning…');
        document.getElementById('scannerResults').innerHTML = '';
        const nameResults = document.getElementById('scannerNameResults');
        if (nameResults) nameResults.innerHTML = '';
        await runMatch(dataURL);
      };
      reader.readAsDataURL(file);
    }

    function openCardScanner() {
      const modal = document.getElementById('scannerModal');
      modal.style.display = 'flex';
      if (window._preloadClip) window._preloadClip().catch(() => {});
    }

    function closeCardScanner() {
      const modal = document.getElementById('scannerModal');
      modal.style.display = 'none';
      window._detectedSlab = null;
      // Reset pre-scan state
      const fallback = document.getElementById('scannerSearchFallback');
      if (fallback) { fallback.style.display = 'none'; fallback.querySelector('input') && (fallback.querySelector('input').value = ''); }
      const nameResults = document.getElementById('scannerNameResults');
      if (nameResults) nameResults.innerHTML = '';
      // If POS mode was active and the user closed the scanner directly
      // (without using EXIT POS), tear down the banner so the next
      // normal scan doesn't show a stale "POS SALE MODE" header. The
      // POS-mode flag itself stays set so the next-sale loop in
      // submitMarkSold doesn't fire mid-close; explicit reopens via
      // openPosSaleScanner reset it anyway.
      const banner = document.getElementById('posScannerBanner');
      if (banner) banner.remove();
      window._posSaleMode = false;
    }

    // ── Auto-scan — frame stability detection ────────────────────────────────
    let _autoScanOn      = false;
    let _autoScanTimer   = null;
    let _prevFramePixels = null;
    let _stableCount     = 0;
    let _autoScanCooldown = false;

    function toggleAutoScan() {
      _autoScanOn = !_autoScanOn;
      const btn = document.getElementById('autoScanBtn');
      if (btn) {
        btn.textContent  = _autoScanOn ? 'AUTO ✓' : 'AUTO';
        btn.style.color  = _autoScanOn ? 'var(--accent)' : 'var(--muted)';
        btn.style.borderColor = _autoScanOn ? 'var(--accent)' : 'var(--border)';
      }
      if (_autoScanOn) _startStabilityLoop();
      else              _stopStabilityLoop();
    }

    function _startStabilityLoop() {
      _stopStabilityLoop();
      _prevFramePixels = null;
      _stableCount = 0;
      _autoScanCooldown = false;
      _autoScanTimer = setInterval(_checkStability, 500);
    }

    function _stopStabilityLoop() {
      if (_autoScanTimer) { clearInterval(_autoScanTimer); _autoScanTimer = null; }
      _prevFramePixels = null;
      _stableCount = 0;
      _setStableDot('idle');
    }

    function _setStableDot(state) {
      const dot = document.getElementById('scanStableDot');
      if (!dot) return;
      if (state === 'idle')   { dot.style.background = 'rgba(255,255,255,0.2)'; dot.style.boxShadow = ''; }
      if (state === 'moving') { dot.style.background = 'var(--muted)';          dot.style.boxShadow = ''; }
      if (state === 'locking'){ dot.style.background = 'var(--accent2)';        dot.style.boxShadow = ''; }
      if (state === 'locked') { dot.style.background = 'var(--accent)';         dot.style.boxShadow = '0 0 8px var(--accent)'; }
    }

    function _setGuideState(state) {
      const guide = document.getElementById('scanCardGuide');
      if (!guide) return;
      guide.classList.remove('locking', 'locked');
      if (state === 'idle')    { guide.style.borderColor = 'rgba(255,255,255,0.35)'; guide.style.borderStyle = 'dashed'; guide.style.boxShadow = ''; }
      if (state === 'locking') { guide.style.borderColor = 'var(--accent2)';         guide.style.borderStyle = 'solid';  guide.style.boxShadow = ''; guide.classList.add('locking'); }
      if (state === 'locked')  { guide.style.borderColor = 'var(--accent)';          guide.style.borderStyle = 'solid';  guide.style.boxShadow = 'inset 0 0 0 2000px rgba(80,200,130,0.10)'; guide.classList.add('locked'); }
    }

    function _checkStability() {
      if (_autoScanCooldown) return;
      const video = document.getElementById('scannerVideo');
      if (!scannerStream || !video || video.readyState < 2 || video.paused) return;

      // Sample a small 64×64 thumbnail for fast comparison
      const sc = document.getElementById('scannerSampleCanvas');
      if (!sc) return;
      const sctx = sc.getContext('2d');
      sctx.drawImage(video, 0, 0, 64, 64);
      const frame = sctx.getImageData(0, 0, 64, 64).data;

      if (_prevFramePixels) {
        let diff = 0;
        for (let i = 0; i < frame.length; i += 4) {
          diff += Math.abs(frame[i]   - _prevFramePixels[i])
                + Math.abs(frame[i+1] - _prevFramePixels[i+1])
                + Math.abs(frame[i+2] - _prevFramePixels[i+2]);
        }
        // avgDiff is mean per-channel pixel delta (0–255 scale)
        const avgDiff = diff / (frame.length / 4 * 3);

        if (avgDiff < 10) {
          _stableCount++;
          if (_stableCount === 1) _setStableDot('locking'), _setGuideState('locking');
          if (_stableCount >= 2)  _setStableDot('locked'),  _setGuideState('locked'), _triggerAutoCapture();
        } else {
          _stableCount = 0;
          _setStableDot('moving');
          _setGuideState('idle');
        }
      }

      _prevFramePixels = frame;
    }

    async function _triggerAutoCapture() {
      _autoScanCooldown = true;
      _stopStabilityLoop();
      // Turn AUTO off after one snap — must be re-enabled manually
      _autoScanOn = false;
      const autoBtn = document.getElementById('autoScanBtn');
      if (autoBtn) { autoBtn.textContent = 'AUTO'; autoBtn.style.color = 'var(--muted)'; autoBtn.style.borderColor = 'var(--border)'; }
      if (navigator.vibrate) navigator.vibrate(60);
      await captureAndMatch();
      _autoScanCooldown = false;
      _setStableDot('idle');
      _setGuideState('idle');
    }

    async function captureAndMatch() {
      const video = document.getElementById('scannerVideo');
      const canvas = document.getElementById('scannerCanvas');

      if (!scannerStream || video.readyState < 2) {
        setScanStatus('Camera not ready — try again');
        return;
      }

      // Hide any upload preview, show video
      const preview = document.getElementById('uploadPreview');
      if (preview) preview.style.display = 'none';
      video.style.display = 'block';

      document.getElementById('scanBtn').textContent = 'Capturing…';

      let dataURL;
      try {
        // ImageCapture API: triggers a full-resolution, autofocused, HDR-processed still
        // — matches the quality of an uploaded photo rather than a raw video frame
        if (typeof ImageCapture !== 'undefined' && scannerStream) {
          const track = scannerStream.getVideoTracks()[0];
          const ic = new ImageCapture(track);
          const blob = await ic.takePhoto();
          dataURL = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload  = e => res(e.target.result);
            reader.onerror = rej;
            reader.readAsDataURL(blob);
          });
        } else {
          throw new Error('fallback');
        }
      } catch (_) {
        // Fallback: grab current video frame (lower quality but always works)
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        dataURL = canvas.toDataURL('image/jpeg', 0.92);
      }

      document.getElementById('scanBtn').textContent = 'Scanning…';
      window._lastScanDataURL = dataURL; // stash for "keep/edit/discard" offer
      await runMatch(dataURL);
    }

    // ── Slab fast-path: cert number found → skip card matching ───────────────
    const _slabCompanyLabels = { psa:'PSA', bgs:'BGS / Beckett', cgc:'CGC', sgc:'SGC', ace:'ACE', tag:'TAG' };

    async function handleSlabScan(slab) {
      const label = _slabCompanyLabels[slab.company] || slab.company.toUpperCase();
      const hasCert = !!slab.certNumber;

      if (slab.company === 'psa' && hasCert) {
        // ── PSA: hit our edge function with one automatic retry ───────────
        setScanStatus('PSA slab · cert #' + slab.certNumber + ' · looking up…');
        let result = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            result = await callEdgeFunction('psa-cert-lookup', { certNumber: slab.certNumber });
            if (result && !result.error) break; // success
            if (attempt === 1) {
              setScanStatus('PSA · retrying…');
              await new Promise(r => setTimeout(r, 1200)); // brief pause before retry
            }
          } catch(e) {
            console.warn('[Slab] PSA attempt ' + attempt, e);
            if (attempt === 2) result = null;
            else await new Promise(r => setTimeout(r, 1200));
          }
        }
        if (result && !result.error) {
          setScanStatus('PSA cert found — opening card details…');
          setTimeout(function() { _openModalFromSlabCert(slab, result); }, 250);
          return;
        }
        // Both attempts failed — show cert number so user can verify manually
        setScanStatus('PSA cert #' + slab.certNumber + ' — lookup failed, add manually or paste cert text below');
      } else if (hasCert) {
        setScanStatus(label + ' slab detected · cert #' + slab.certNumber);
      } else {
        // Slab company detected but cert digits weren't readable
        setScanStatus(label + ' slab detected — couldn\'t read cert number, enter it below or paste cert text');
      }

      // ── Show cert panel: verify link (if cert known) + paste box ────
      const certUrl = (hasCert && typeof _certLookupUrls !== 'undefined' && _certLookupUrls[slab.company])
        ? _certLookupUrls[slab.company](slab.certNumber)
        : null;

      // When the OCR couldn't read the cert digits we show a manual
      // input so the user can type/paste it. The Verify link and paste
      // tools then become available once a cert is entered.
      const certBlock = hasCert
        ? `<div style="font-size:.68rem;color:var(--muted);margin-bottom:12px">Cert # ${slab.certNumber}</div>`
        : `<div style="font-size:.66rem;color:var(--gold);margin-bottom:8px;line-height:1.45">⚠ Cert # not readable from photo — enter it below to enable lookup &amp; verify link.</div>
           <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px">
             <input id="slabManualCert" type="text" inputmode="numeric" autocomplete="off"
               placeholder="Cert # (e.g. 12345678)"
               style="flex:1;background:rgba(0,0,0,.35);border:1px solid var(--border);color:var(--text);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.78rem;padding:7px 9px;letter-spacing:.06em;box-sizing:border-box;outline:none">
             <button onclick="_applyManualSlabCert('${slab.company}','${slab.grade||''}')"
               style="padding:7px 12px;border:1px solid var(--teal);background:transparent;color:var(--teal);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.65rem;cursor:pointer;white-space:nowrap">
               ⟳ Apply
             </button>
           </div>`;

      const wrap = document.getElementById('scannerResults');
      if (wrap) wrap.innerHTML = `
        <div style="background:rgba(26,199,160,.08);border:1px solid var(--teal);padding:14px 16px;font-family:'Space Mono','Share Tech Mono',monospace;margin-bottom:10px">
          <div style="font-size:.56rem;color:var(--teal);letter-spacing:.1em;margin-bottom:8px">◈ GRADED SLAB DETECTED</div>
          <div style="font-size:.9rem;color:var(--text);font-weight:700;margin-bottom:3px">${label}</div>
          ${slab.grade ? `<div style="font-size:.72rem;color:var(--accent);margin-bottom:3px">Grade: ${slab.grade}</div>` : ''}
          ${certBlock}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            ${certUrl ? `<a href="${certUrl}" target="_blank" rel="noopener"
              style="padding:7px 14px;border:1px solid var(--teal);color:var(--teal);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.68rem;text-decoration:none;cursor:pointer">
              ↗ Verify on ${label}
            </a>` : ''}
            <button onclick="openManualSlabAdd('${slab.company}','${slab.certNumber||''}','${slab.grade||''}')"
              style="padding:7px 14px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.68rem;cursor:pointer">
              + Add to My Binder
            </button>
          </div>
          <div style="border-top:1px solid rgba(26,199,160,.2);padding-top:12px">
            <div style="font-size:.6rem;color:var(--teal);letter-spacing:.08em;margin-bottom:5px">◈ PASTE CERT PAGE TEXT TO AUTO-FILL</div>
            <div style="font-size:.61rem;color:var(--muted);margin-bottom:7px;line-height:1.5">Open the verify link above → pass any check → select all (Ctrl+A) → copy (Ctrl+C) → paste below. Works for any language card.</div>
            <textarea id="slabPasteArea" rows="4"
              style="width:100%;background:rgba(0,0,0,.35);border:1px solid var(--border);color:var(--text);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.61rem;padding:7px;resize:vertical;box-sizing:border-box"
              placeholder="Paste cert page text here…"></textarea>
            <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
              <button onclick="parsePastedCertText('${slab.company}','${slab.certNumber||''}','${slab.grade||''}')"
                style="padding:6px 14px;border:1px solid var(--teal);background:transparent;color:var(--teal);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.65rem;cursor:pointer">
                ⟳ Parse &amp; Fill
              </button>
              <span id="slabParseStatus" style="font-size:.6rem;color:var(--muted)"></span>
            </div>
          </div>
        </div>`;
    }

    // Re-render the slab panel with the manually-entered cert number,
    // unlocking the Verify link and enabling proper add-to-binder.
    function _applyManualSlabCert(company, grade) {
      var input = document.getElementById('slabManualCert');
      if (!input) return;
      var cert = (input.value || '').trim().replace(/[^\dA-Za-z]/g, '');
      if (!cert || cert.length < 5) {
        input.style.borderColor = 'var(--gold)';
        input.focus();
        return;
      }
      var slab = window._detectedSlab || { company: company, grade: grade };
      slab.certNumber = cert;
      window._detectedSlab = slab;
      handleSlabScan(slab);
    }

    // ── Parse pasted cert page text for non-PSA slabs ────────────────────────
    // After user passes CAPTCHA on a cert site and copies the page text, this
    // extracts card name, grade, year, set, language and opens the add modal.
    function parsePastedCertText(company, certNumber, detectedGrade) {
      var textarea = document.getElementById('slabPasteArea');
      var statusEl = document.getElementById('slabParseStatus');
      var raw = textarea ? textarea.value.trim() : '';
      if (!raw) { if (statusEl) statusEl.textContent = '⚠ Paste some text first'; return; }

      // ── Step 1: Parse label/value pairs — supports TWO formats: ────────────
      // Format A (CGC, BGS, SGC): "Label\nValue\nLabel\nValue" (label and value on separate lines)
      // Format B (TAG Grading):   "LABEL:Value" (label and value on the same line, colon-separated)
      // We try both and merge results.

      var LABEL_MAP = {
        // Format A keys (case-insensitive, trim trailing colons/spaces)
        'cert #':               'cert',
        'cert number':          'cert',
        'certification':        'cert',
        'certification number': 'cert',
        'serial number':        'cert',
        'card name':            'cardName',
        'player name':          'cardName',   // TAG Grading uses "PLAYER NAME"
        'subject':              'cardName',
        'item':                 'cardName',
        'description':          'cardName',
        'game':                 'game',
        'year':                 'year',
        'language':             'language',
        'card set':             'set',
        'set name':             'set',        // TAG Grading uses "SET NAME"
        'set':                  'set',
        'series':               'set',
        'edition':              'set',
        'collection':           'set',
        'subset':               'subset',     // TAG Grading uses "SUBSET"
        'card number':          'cardNumber',
        'number':               'cardNumber',
        'variant 1':            'variant1',
        'variant 2':            'variant2',
        'variation':            'variant1',   // TAG Grading uses "VARIATION"
        'variant':              'variant1',
        'finish':               'variant2',
        'variety':              'variant1',
        'grade':                'grade',
        'final grade':          'grade',
        'overall grade':        'grade',
        'grader notes':         'notes',
        'population':           'pop',
        'total population':     'pop',
      };

      var lines = raw.split(/\n/).map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
      var kv = {};

      // Format A: walk through lines — if a line matches a known label, next non-label line is value
      for (var i = 0; i < lines.length; i++) {
        var key = lines[i].toLowerCase().replace(/[:\s]+$/, '').trim();
        if (LABEL_MAP[key] && i + 1 < lines.length) {
          var field = LABEL_MAP[key];
          var val   = lines[i + 1].trim();
          if (!LABEL_MAP[val.toLowerCase().replace(/[:\s]+$/, '')]) {
            if (!kv[field]) kv[field] = val;
          }
        }
      }

      // Format B: colon-separated on same line ("PLAYER NAME:Mega Dragonite EX")
      // This handles TAG Grading and other sites that concatenate label+value
      lines.forEach(function(line) {
        var colonIdx = line.indexOf(':');
        if (colonIdx > 0 && colonIdx < 40) { // label shouldn't be longer than 40 chars
          var lKey = line.substring(0, colonIdx).trim().toLowerCase();
          var lVal = line.substring(colonIdx + 1).trim();
          if (LABEL_MAP[lKey] && lVal && !kv[LABEL_MAP[lKey]]) {
            kv[LABEL_MAP[lKey]] = lVal;
          }
        }
      });

      // ── Step 2: Extract grade number from grade string like "GEM MINT 10" ──
      var gradeRaw = kv.grade || '';
      var gradeNum = '';
      var gradeNumMatch = gradeRaw.match(/(\d{1,2}(?:\.\d)?)[\s]*$/);
      if (gradeNumMatch) {
        gradeNum = gradeNumMatch[1];
      } else if (gradeRaw) {
        // "AUTHENTIC" / "A" grades → treat as special
        gradeNum = detectedGrade || '';
      }
      // If structured parse found nothing, fall back to regex scan of full text
      if (!gradeNum) {
        var gm = raw.match(/(?:GEM[-\s]?MINT|GEM[-\s]?MT|MINT|NEAR\s*MINT|EXCELLENT|VERY\s*GOOD)[\s\-]*(\d{1,2}(?:\.\d)?)/i)
              || raw.match(/\b(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3|2|1)\b/);
        gradeNum = gm ? (gm[1] || gm[0]).replace(/[^\d.]/g,'') : (detectedGrade || '');
      }

      // ── Step 3: Assemble fields ───────────────────────────────────────────
      var cardName   = kv.cardName || '';
      var year       = kv.year || (raw.match(/\b(19[9]\d|20[0-2]\d)\b/) || [])[1] || '';
      var lang       = kv.language || '';
      // If language wasn't a labelled field, detect from text keywords
      if (!lang) {
        if (/\bJAPAN(ESE)?\b/i.test(raw))           lang = 'Japanese';
        else if (/\bCHINES[E]?\b|\bCHINA\b/i.test(raw)) lang = 'Chinese';
        else if (/\bKOREAN?\b/i.test(raw))           lang = 'Korean';
        else if (/\bFRENCH\b|\bFRANÇAIS\b/i.test(raw))  lang = 'French';
        else if (/\bGERMAN\b|\bDEUTSCH\b/i.test(raw))   lang = 'German';
        else if (/\bSPANISH\b|\bESPAÑOL\b/i.test(raw))  lang = 'Spanish';
        else if (/\bITALIAN\b|\bITALIANO\b/i.test(raw)) lang = 'Italian';
        else if (/\bPORTUGUES[E]?\b/i.test(raw))     lang = 'Portuguese';
      }
      var setName    = kv.set || '';
      var rawCardNum = kv.cardNumber || '';
      // Card number: take just the number before the "/" (e.g. "243/184" → "243")
      var cardNumber = (rawCardNum.match(/^(\d+)/) || [])[1] || '';
      // Variant info → variety field (e.g. "Character Super Rare · Holo")
      var variety    = [kv.variant1, kv.variant2].filter(Boolean).join(' · ');

      // ── Step 4: Build set display string (deduplicated) ───────────────────
      // TAG's "SET NAME" field includes year ("2026 POKÉMON MEGA EVOLUTION#271/217")
      // Extract embedded card number from set name if not already found
      if (!cardNumber && kv.set) {
        var embeddedNum = kv.set.match(/#(\d+)\/\d+/);
        if (embeddedNum) cardNumber = embeddedNum[1];
      }
      // Also pull in subset as part of set display (TAG uses SUBSET for sub-series name)
      var subsetName = kv.subset || '';
      // Clean embedded card number from set name for display
      var cleanSetName = (kv.set || '').replace(/#\d+\/\d+/, '').trim();
      // If set name already starts with year, don't prepend year again
      var setStartsWithYear = year && cleanSetName.startsWith(year);
      var setParts = [];
      if (year && !setStartsWithYear) setParts.push(year);
      if (lang && (!cleanSetName || !cleanSetName.toLowerCase().includes(lang.toLowerCase()))) setParts.push(lang);
      if (cleanSetName) setParts.push(cleanSetName);
      if (subsetName && !cleanSetName.toLowerCase().includes(subsetName.toLowerCase())) setParts.push(subsetName);
      var setDisplay = setParts.join(' · ');

      // ── Step 5: Validate ──────────────────────────────────────────────────
      var found = [];
      if (cardName)   found.push('name');
      if (gradeNum)   found.push('grade ' + gradeNum);
      if (year)       found.push('year');
      if (setName)    found.push('set');
      if (cardNumber) found.push('#' + cardNumber);
      if (lang)       found.push(lang);
      if (variety)    found.push('variant');

      if (!cardName && !gradeNum) {
        if (statusEl) statusEl.textContent = '⚠ Couldn\'t parse — make sure to copy the full cert page text';
        return;
      }

      // ── Step 6: Open add-to-collection modal pre-filled ───────────────────
      var fakeCert = {
        cardName:   cardName   || 'Unknown Card',
        grade:      gradeNum   || detectedGrade || '10',
        certNumber: certNumber,
        year:       year,
        brand:      setDisplay,
        cardNumber: cardNumber,
        variety:    variety || lang,
        imageUrl:   null,
        gradeDesc:  company.toUpperCase() + ' ' + gradeRaw,
        specUrl:    null
      };

      _returnToScanner = true;
      document.getElementById('scannerModal').style.display = 'none';
      _openModalFromSlabCert({ company: company, certNumber: certNumber, grade: gradeNum || detectedGrade }, fakeCert);

      if (statusEl) statusEl.textContent = '✓ Filled: ' + found.join(' · ');
    }

    // ── Binder card-detail variant chip renderer ────────────────────────
    // After openBinderCardDetail builds the modal, this fills the
    // `binderVariantChips_<id>` div with chips showing which finishes
    // exist for this card AND which the user owns. Clicking a chip the
    // user doesn't own inserts a new collection_items row for that
    // variant (two-row binder model).
    async function _renderBinderVariantChips(item) {
      const slot = document.getElementById('binderVariantChips_' + item.id);
      if (!slot || !item.api_card_id) return;
      if ((item.game_type || 'pokemon').toLowerCase() !== 'pokemon') return;
      // What variants does this catalog row support?
      let hasRH = false;
      try {
        const r = await sb.from('catalog')
          .select('has_reverse_holo')
          .eq('id', item.api_card_id)
          .maybeSingle();
        if (r && r.data) hasRH = !!r.data.has_reverse_holo;
      } catch(_) {}
      if (!hasRH) { slot.style.display = 'none'; return; }
      // Which variants of this api_card_id does the current user already own?
      const owned = new Set();
      collectionItems.forEach(function(c) {
        if (String(c.api_card_id) === String(item.api_card_id)) {
          owned.add(c.variant || 'normal');
        }
      });
      const variants = [
        { key: 'normal',       label: 'Normal' },
        { key: 'reverse_holo', label: 'Reverse Holo' },
      ];
      slot.innerHTML =
        '<div style="font-size:.6rem;color:var(--muted);letter-spacing:.06em;margin-bottom:5px">VARIANTS OWNED</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
        + variants.map(function(v) {
            const isOwned = owned.has(v.key);
            const isMe    = (item.variant || 'normal') === v.key;
            const bg      = isMe ? 'rgba(26,199,160,.18)' : (isOwned ? 'rgba(26,199,160,.06)' : 'transparent');
            const border  = isMe ? 'var(--accent)' : (isOwned ? 'rgba(26,199,160,.4)' : 'var(--border)');
            const color   = isMe ? 'var(--accent)' : (isOwned ? 'var(--accent)' : 'var(--muted)');
            const mark    = isOwned ? (isMe ? '✓ ' : '') : '+ ';
            // If owned and not the current card, jump to that variant's
            // row via openBinderCardDetail (single click swap). If not
            // owned, click adds a new row.
            let onClick;
            if (isMe) {
              onClick = '';
            } else if (isOwned) {
              // Find the OTHER row's id for this api_card_id+variant.
              let targetId = '';
              for (let i = 0; i < collectionItems.length; i++) {
                const c = collectionItems[i];
                if (String(c.api_card_id) === String(item.api_card_id)
                    && (c.variant || 'normal') === v.key
                    && String(c.id) !== String(item.id)) { targetId = c.id; break; }
              }
              // _variantChipNavLock blocks the OWNED-chip's navigation
              // for ~1.5s after a successful _addVariantOfCard. Without
              // this guard, a user who taps "+ Reverse Holo" twice in
              // quick succession ends up navigating to the new qty=1
              // row immediately after creating it — which looked like
              // the stack had collapsed back to a solo card modal.
              onClick = targetId
                ? 'onclick="if(window._variantChipNavLock)return;closeModal(\'binderDetailModal\');setTimeout(function(){openBinderCardDetail(\'' + targetId + '\')},80)"'
                : '';
            } else {
              onClick = 'onclick="_addVariantOfCard(\'' + item.id + '\',\'' + v.key + '\')"';
            }
            return '<button type="button" ' + onClick
                + ' style="padding:5px 11px;border:1px solid ' + border + ';'
                + 'background:' + bg + ';color:' + color + ';'
                + 'font-family:\'Space Mono\',\'Share Tech Mono\',monospace;font-size:.65rem;'
                + 'letter-spacing:.05em;cursor:' + (isMe ? 'default' : 'pointer') + ';'
                + 'border-radius:var(--r-sm,6px);transition:all .12s">'
                + mark + v.label + '</button>';
          }).join('')
        + '</div>';
    }

    // Inserts a new collection_items row for a different finish of the
    // same catalog card. Clones the relevant fields from the source row
    // (image, set, number, binder placement) so the new variant row
    // shows up where the user expects.
    async function _addVariantOfCard(sourceItemId, variant) {
      if (!currentUser) { showToast('Sign in first'); return; }
      const src = collectionItems.find(function(c){ return String(c.id) === String(sourceItemId); });
      if (!src) { showToast('Source card not found'); return; }
      const payload = {
        user_id:        currentUser.id,
        api_card_id:    src.api_card_id,
        card_name:      src.card_name,
        set_name:       src.set_name,
        set_code:       src.set_code,
        card_number:    src.card_number,
        card_image_url: src.card_image_url,
        game_type:      src.game_type,
        condition:      'raw',
        quantity:       1,
        binder_id:      src.binder_id,
        language:       src.language,
        rarity:         src.rarity,
        variant:        variant,
      };
      const res = await sb.from('collection_items').insert(payload).select().single();
      if (res.error) { showToast('Add failed: ' + res.error.message); return; }
      // Refresh local cache so the chip re-render sees the new row
      try { collectionItems.push(res.data); } catch(_) {}
      showToast('Added ' + (variant === 'reverse_holo' ? 'Reverse Holo' : variant) + ' variant');
      // Block the now-OWNED chip from navigating for a beat so a rapid
      // double-tap doesn't ricochet into the new qty=1 row. The chip
      // renders with the navigation onclick guarded by this flag.
      window._variantChipNavLock = true;
      setTimeout(function() { window._variantChipNavLock = false; }, 1500);
      // STAY on the current card's detail modal. Previously we auto-
      // navigated to the new variant row, which had qty=1 and therefore
      // no unit stack — the visible effect was "the stack collapsed".
      // Now: refresh the variant chips so the newly-added variant
      // shows as OWNED (with the navigate-on-click affordance), but
      // leave the user looking at the card they were already on. They
      // can click the new variant's chip if they want to jump to it.
      try {
        // Find the source item from the in-memory cache to refresh chips
        var srcRow = collectionItems.find(function(c){ return String(c.id) === String(sourceItemId); });
        if (srcRow) _renderBinderVariantChips(srcRow);
      } catch (e) { console.warn('[variants] post-add chip refresh failed:', e && e.message); }
    }

    // Resolve a graded slab's PSA / cert metadata to a row in our catalog
    // so the saved collection_items.api_card_id points somewhere real.
    // Without this, slab cards never pick up multi-source comp prices
    // (_enrichOwnedFromComps / _renderBinderExtrasPlaceholder both filter
    // on api_card_id) and the PRICE_TREND chart has no series to draw.
    //
    // Strategy:
    //   1. Card-number lookup against the en- catalog (slab path is
    //      Pokemon-only today; gameType is hard-coded below).
    //   2. Filter results by case-insensitive name match — try the full
    //      cert name first, then a suffix-stripped baseName ('Charizard
    //      ex' → 'Charizard') so pokedata rows that drop the ex/V suffix
    //      still hit.
    //   3. Score remaining candidates by token overlap against the
    //      cert's brand + year tokens vs catalog set_name (PSA brand
    //      'Pokemon Game' + year '1999' should beat a Charizard #4
    //      from a 2024 reprint).
    //   4. Top-scoring candidate wins; ties / zero hits → null
    //      (caller leaves api_card_id null, user can edit later).
    async function _linkSlabToCatalog(cert) {
      if (!cert) return { apiCardId: null, matches: [] };
      const name = String(cert.cardName || '').trim();
      const num  = String(cert.cardNumber || '').trim();
      if (!name && !num) return { apiCardId: null, matches: [] };

      let rows = [];
      if (num) {
        try {
          rows = await _pbSearchCatalogByCardNumber({ num: num, total: null }, 'en-', 100);
        } catch(_) { rows = []; }
      }
      // Name-only fallback for slabs missing a card_number (older
      // promos, oddities, etc.). Caps at 100 rows so a common name
      // like 'Pikachu' doesn't pull the whole catalog.
      if (!rows.length && name) {
        try {
          const r = await sb.from('catalog')
            .select('id, name, set_name, card_number, game_type')
            .ilike('name', '%' + name + '%')
            .ilike('id', 'en-%')
            .limit(100);
          if (!r.error && r.data) rows = r.data;
        } catch(_) {}
      }
      if (!rows.length) return { apiCardId: null, matches: [] };

      const nameLc = name.toLowerCase();
      const baseLc = nameLc.replace(/\s+(ex|v|vmax|vstar|gx|vunion)$/i, '').trim();
      let candidates = rows.filter(function(r) {
        const rn = (r.name || '').toLowerCase();
        return rn === nameLc || rn === baseLc || rn.includes(nameLc) || nameLc.includes(rn);
      });
      // If the name filter wipes everything out, fall back to the raw
      // number hits (catalog name might be wildly different from the
      // cert text — Promo cards are notorious for this).
      if (!candidates.length) candidates = rows;

      const yearStr = String(cert.year || '').trim();
      const brandLc = String(cert.brand || '').toLowerCase();
      const brandTokens = brandLc.split(/\s+/).filter(function(t) { return t.length >= 3; });

      candidates.forEach(function(c) {
        const sn = (c.set_name || '').toLowerCase();
        let score = 0;
        if (yearStr && sn.indexOf(yearStr) !== -1) score += 2;
        brandTokens.forEach(function(t) { if (sn.indexOf(t) !== -1) score += 1; });
        if ((c.name || '').toLowerCase() === nameLc) score += 1;
        c._linkScore = score;
      });
      candidates.sort(function(a, b) { return (b._linkScore || 0) - (a._linkScore || 0); });

      const top    = candidates[0];
      const second = candidates[1];
      // Pick the top match. When the runner-up ties on score, log so we
      // can see how often the heuristic is ambiguous — useful for tuning.
      if (second && (top._linkScore || 0) === (second._linkScore || 0)) {
        console.log('[Slab] ambiguous catalog link for "' + name + '" #' + num +
                    ' — ' + candidates.slice(0, 5).map(function(c){return c.id;}).join(', '));
      }
      return {
        apiCardId: top.id,
        matches: candidates.slice(0, 5).map(function(c) {
          return { id: c.id, name: c.name, set_name: c.set_name, card_number: c.card_number, score: c._linkScore || 0 };
        }),
      };
    }

    // Opens the add-to-collection modal pre-filled from a PSA cert API result
    async function _openModalFromSlabCert(slab, cert) {
      _returnToScanner = true;
      document.getElementById('scannerModal').style.display = 'none';

      // Resolve to a real catalog row before building pendingCollectionCard
      // so api_card_id points somewhere on save. Falls back to null on
      // miss; user can still save (and link manually later via edit).
      const link = await _linkSlabToCatalog(cert);
      if (link.apiCardId) {
        console.log('[Slab] linked to catalog row:', link.apiCardId,
                    '(from ' + link.matches.length + ' candidate(s))');
      }

      pendingCollectionCard = {
        apiCardId:    link.apiCardId,
        cardName:     cert.cardName  || '',
        setName:      [cert.brand, cert.year].filter(Boolean).join(' ') || '',
        setCode:      '',
        cardNumber:   cert.cardNumber || '',
        cardImageUrl: '',
        gameType:     'pokemon',
        _psaImageUrl: cert.imageUrl  || null
      };

      // Card name header
      var nameEl = document.getElementById('atcCardName');
      if (nameEl) nameEl.textContent = (cert.cardName || 'Unknown Card');
      // Show manual name row so they can correct if needed
      var manualRow = document.getElementById('atcManualNameRow');
      if (manualRow) manualRow.style.display = '';
      var manualInput = document.getElementById('atcManualNameInput');
      if (manualInput) manualInput.value = cert.cardName || '';

      // Condition / grade
      var condEl = document.getElementById('atcCondition');
      if (condEl) condEl.value = slab.company;
      var validGrades = ['10','9.5','9','8.5','8','7.5','7','6.5','6','5.5','5','4.5','4','3','2','1'];
      var grade = cert.grade || slab.grade || '10';
      var gradeEl = document.getElementById('atcGrade');
      if (gradeEl) gradeEl.value = validGrades.includes(grade) ? grade : '10';

      // Cert number
      var certEl = document.getElementById('atcCertNumber');
      if (certEl) certEl.value = cert.certNumber || slab.certNumber || '';

      // Reset other fields
      document.getElementById('atcQuantity').value = '1';
      document.getElementById('atcPurchasePrice').value = '';
      document.getElementById('atcPurchaseDate').value = '';
      document.getElementById('atcPriceUrl').value = '';
      document.getElementById('atcNotes').value = '';
      atcClearPhoto();
      atcOfferScanPhoto(); // offer scan photo to keep/edit/discard
      toggleGradeField();   // must come BEFORE setting _atcPsaData (it calls atcCertReset internally)

      // Show PSA cert preview panel (same as after manual lookup)
      _atcPsaData = cert;
      var preview = document.getElementById('atcCertPreview');
      var imgEl   = document.getElementById('atcCertImg');
      var cName   = document.getElementById('atcCertCardName');
      var cGrade  = document.getElementById('atcCertGradeDesc');
      var cMeta   = document.getElementById('atcCertMeta');
      var cLink   = document.getElementById('atcCertLink');
      var compLabel = (_certCompanyNames && _certCompanyNames[slab.company]) || (slab.company ? slab.company.toUpperCase() : 'PSA');
      if (imgEl)  { imgEl.src = cert.imageUrl || ''; imgEl.style.display = cert.imageUrl ? '' : 'none'; }
      if (cName)  cName.textContent  = cert.cardName || '';
      if (cGrade) cGrade.textContent = cert.gradeDesc || (compLabel + ' ' + (cert.grade || '?'));
      var meta = [cert.year, cert.brand, cert.variety, cert.cardNumber ? '#'+cert.cardNumber : ''].filter(Boolean).join(' · ');
      if (cMeta)  cMeta.textContent = meta;
      if (cLink) {
        var certNum = cert.certNumber || slab.certNumber || '';
        var urlFn = _certLookupUrls && _certLookupUrls[slab.company];
        cLink.href = cert.specUrl || (urlFn && certNum ? urlFn(certNum) : '#');
        cLink.textContent = 'View on ' + compLabel + ' ↗';
        cLink.style.display = '';
      }
      if (preview) preview.style.display = '';
      atcUpdateCertBtn();

      populateBinderDropdown('atcBinderId', currentBinderId);
      openModal('addToCollectionModal');
    }

    // Opens the add-to-collection modal in manual-entry mode pre-filled from slab data
    function openManualSlabAdd(company, certNumber, grade) {
      pendingCollectionCard = { apiCardId:null, cardName:'', setName:'', setCode:'', cardNumber:'', cardImageUrl:'', gameType:'pokemon' };
      var nameEl = document.getElementById('atcCardName');
      if (nameEl) nameEl.textContent = 'Manual Entry';
      var manualRow = document.getElementById('atcManualNameRow');
      if (manualRow) manualRow.style.display = '';
      var manualInput = document.getElementById('atcManualNameInput');
      if (manualInput) manualInput.value = '';

      var condEl = document.getElementById('atcCondition');
      if (condEl && ['psa','bgs','cgc','sgc','ace','tag'].includes(company)) condEl.value = company;
      var gradeEl = document.getElementById('atcGrade');
      var validGrades = ['10','9.5','9','8.5','8','7.5','7','6.5','6','5.5','5','4.5','4','3','2','1'];
      if (gradeEl) gradeEl.value = validGrades.includes(grade) ? grade : '10';
      var certEl = document.getElementById('atcCertNumber');
      if (certEl) certEl.value = certNumber || '';

      document.getElementById('atcQuantity').value = '1';
      document.getElementById('atcPurchasePrice').value = '';
      document.getElementById('atcPurchaseDate').value = '';
      document.getElementById('atcPriceUrl').value = '';
      document.getElementById('atcNotes').value = '';
      atcClearPhoto();
      atcOfferScanPhoto(); // offer scan photo to keep/edit/discard
      toggleGradeField();
      atcUpdateCertBtn();
      populateBinderDropdown('atcBinderId', currentBinderId);

      _returnToScanner = true;
      document.getElementById('scannerModal').style.display = 'none';
      openModal('addToCollectionModal');
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Store for detail preview
    window._scanMatches = [];

    // ── Product Category config (multi-category marketplace) ───────────
    // Each category defines:
    //   key           — matches product_categories.key in Supabase
    //   display       — human label
    //   photoAspect   — preferred photo aspect ratio (informational)
    //   fields        — listing-form schema (label, type, key, placeholder)
    //   scannerType   — extractor used by the shop product scanner
    //                   'tcg' (existing card scanner — never touched)
    //                   'funko' (Funko Pop OCR heuristics, see _extractFunkoFromOcr)
    //                   null    (no scanner support yet — manual entry only)
    //
    // To add a category: drop a new key into this object + flip is_active=true
    // in product_categories. The listing UI / browse filter / scanner all
    // read from this single source of truth.
    // ── Funko Pop OCR extractor ────────────────────────────────────────
    // Parses raw GCV text from a Funko box. Looks for:
    //   - Pop number ("#NN" or just digits near "POP!"/"FUNKO" branding)
    //   - Character name (the largest text line, usually all-caps)
    //   - Series hints ("MARVEL", "DC", "STAR WARS", "POKEMON", common franchises)
    //   - Exclusivity markers ("HOT TOPIC", "GAMESTOP", "TARGET EXCLUSIVE", etc.)
    //   - Chase variant indicator
    // Returns a best-effort partial { character, series, pop_number, exclusive,
    // is_chase } — caller fills in what's confident and leaves blanks for the
    // shop to complete in the autofill form.
    function _extractFunkoFromOcr(text) {
      if (!text) return {};
      var out = {};
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);

      // Pop number — usually "#NN" but sometimes just a number near POP! branding
      var numMatch = text.match(/#\s*(\d{1,5})/);
      if (numMatch) out.pop_number = '#' + numMatch[1];

      // Series hints from common franchise keywords
      var SERIES_KEYWORDS = [
        ['MARVEL', 'Marvel'], ['DC COMICS', 'DC Comics'], ['DC', 'DC'],
        ['STAR WARS', 'Star Wars'], ['POKEMON', 'Pokemon'], ['POKÉMON', 'Pokemon'],
        ['HARRY POTTER', 'Harry Potter'], ['DISNEY', 'Disney'],
        ['GAME OF THRONES', 'Game of Thrones'], ['STRANGER THINGS', 'Stranger Things'],
        ['NARUTO', 'Naruto'], ['DRAGON BALL', 'Dragon Ball'],
        ['MY HERO ACADEMIA', 'My Hero Academia'], ['ONE PIECE', 'One Piece'],
        ['ANIMATION', 'Animation'], ['TELEVISION', 'TV'], ['MOVIES', 'Movies'],
        ['ROCKS', 'Rocks'], ['GAMES', 'Games'], ['HEROES', 'Heroes'],
      ];
      for (var i = 0; i < SERIES_KEYWORDS.length; i++) {
        var k = SERIES_KEYWORDS[i];
        if (text.toUpperCase().indexOf(k[0]) >= 0) { out.series = k[1]; break; }
      }

      // Exclusivity — common store-exclusive markers
      var EXCLUSIVE_RE = /(HOT\s*TOPIC|GAMESTOP|TARGET|WALMART|BOX\s*LUNCH|FYE|AMAZON|FUNKO\.?COM)[^\\n]*EXCLUSIVE/i;
      var excMatch = text.match(EXCLUSIVE_RE);
      if (excMatch) {
        out.exclusive = excMatch[0].replace(/\s+/g, ' ').trim();
      } else if (/EXCLUSIVE/i.test(text)) {
        // Found EXCLUSIVE without a known retailer — flag it for the user
        out.exclusive = 'Exclusive (specify retailer)';
      }

      // Chase variant
      if (/CHASE(?!\s*POP)/i.test(text)) out.is_chase = true;

      // Character name — heuristic: walk lines in OCR order (top-to-bottom)
      // and pick the FIRST one that looks like a character name. The OLD
      // version picked the longest line, which let "VINYL FIGURE/FIGURINE
      // EN VINYLE" (the bilingual product-type label, always longer than
      // the actual character name) win every time.
      //
      // SKIP rules — match anywhere in the line, not just exact match:
      //   - Branding: Funko, Pop!, Animation, Television, etc.
      //   - Bilingual product type: "Vinyl Figure", "Figurine en Vinyle",
      //     "Figura de Vinil" (always has a slash or appears across langs)
      //   - Legal copy: "Warning", "Choking Hazard", "Attention", "Age",
      //     "Months", "Parts", "©", "®", "TM"
      //   - Pure numbers / SKUs / single-letter noise
      var SKIP_SUBSTR = [
        'FUNKO', 'POP!', 'VINYL FIGURE', 'FIGURINE', 'FIGURA', 'VINILO',
        'EXCLUSIVE', 'HOT TOPIC', 'GAMESTOP', 'TARGET', 'WALMART',
        'BOX LUNCH', 'FYE', 'AMAZON', 'WARNING', 'CHOKING', 'HAZARD',
        'ATTENTION', 'ADVERTENCIA', 'PELIGRO', 'ASFIXIA',
        'SMALL PARTS', 'PETITES PIÈCES', 'PARTES PEQUEÑAS',
        'NOT SUITABLE', 'CHILDREN UNDER', 'MONTHS', 'MOIS', 'MESES',
        'CONVIENT PAS', 'NO ES ADECUADO', 'ADEQUADO',
        '©', '®', '™', 'WWW.', 'HTTP', '.COM'
      ];
      var SERIES_LINE_RE = /^(ANIMATION|TELEVISION|MOVIES|HEROES|GAMES|ROCKS|MARVEL|DC|DC\s*COMICS|STAR\s*WARS|DISNEY|POKEMON|POK[ÉE]MON|HARRY\s*POTTER|GAME\s*OF\s*THRONES|STRANGER\s*THINGS|NARUTO|DRAGON\s*BALL|MY\s*HERO\s*ACADEMIA|ONE\s*PIECE)$/i;

      function _isSkipLine(ln) {
        var upper = ln.toUpperCase();
        // Bilingual product labels usually have a slash (e.g. "VINYL FIGURE/FIGURINE EN VINYLE")
        if (ln.indexOf('/') >= 0 && /VINYL|FIGURE|FIGURIN/i.test(ln)) return true;
        // Pure numeric / SKU
        if (/^[\d#\s\-]+$/.test(ln)) return true;
        // Known noise substrings
        for (var k = 0; k < SKIP_SUBSTR.length; k++) {
          if (upper.indexOf(SKIP_SUBSTR[k]) >= 0) return true;
        }
        // A series-only line is a series keyword, not a character
        if (SERIES_LINE_RE.test(ln)) return true;
        return false;
      }

      var bestName = null;
      for (var i2 = 0; i2 < lines.length; i2++) {
        var ln = lines[i2];
        // Character names are usually 2-30 chars, contain letters
        if (ln.length < 2 || ln.length > 30) continue;
        if (!/[A-Za-z]/.test(ln)) continue;
        if (_isSkipLine(ln)) continue;
        // First valid line wins — Funko boxes lead with the character.
        bestName = ln;
        break;
      }
      if (bestName) {
        // Strip trailing SKU / barcode digits that sometimes get joined to
        // the name on dense boxes ("MobPsycho 2406" → "MobPsycho").
        out.character = bestName.replace(/\s+\d{3,}$/, '').trim();
      }

      return out;
    }

    // ── Product-type detector for the shop scanner ───────────────────────
    // Reads the OCR text and picks one of: funko_pop | manga | poster |
    // plush | statue | other. Each branch then routes to a category-
    // specific extractor that knows what fields to surface. Scoring
    // POS inventory fallback — scores the user's in-memory inventory
    // against the OCR text by token overlap. Fires when the regular
    // card-scan path returned nothing AND we're in POS mode AND the
    // _posIdSet is populated. Designed to catch booster boxes, ETBs,
    // Funkos, manga, plush — anything whose layout doesn't match
    // the TCG card template the rest of the scanner is tuned for.
    //
    // No DB queries — collectionItems is already loaded in memory
    // and was scoped to vendor+ inventory by the time we got here.
    // Score = count of distinct query tokens that appear in
    // (card_name + set_name + card_number). Ties broken by tokens-in-
    // card-name-specifically (more anchored than set name).
    //
    // Threshold: at least 2 distinct query tokens must match. Single-
    // token overlap is too noisy (any "POKEMON" word matches every
    // Pokemon row). Returns up to 8 matches shaped to look like the
    // catalog rows the regular scanner produces, so the downstream
    // showScanResults / confirmScanMatch flow doesn't need changes.
    function _posInventoryFallback(fullOcrText, parsedName) {
      try {
        if (typeof collectionItems === 'undefined' || !Array.isArray(collectionItems)) return [];
        // Detect whether what we're looking at is product packaging
        // vs a card. Product OCR has packaging-specific phrases
        // ("ADDITIONAL GAME CARDS", "BOOSTER PACK", "ELITE TRAINER
        // BOX", quantity glyphs like "10 cards") and lacks card-
        // specific markers (HP value, STAGE, "Evolves from"). When we
        // detect product-mode, single-card rows are EXCLUDED from
        // the inventory pool — they were the noise source on the
        // Chaos Rising booster scan where tokens like "evolution"
        // and "chaos" matched random Pokemon ex cards.
        var rawLc = String(fullOcrText || '').toLowerCase();
        var productSignals =
          /\b(additional game cards|booster\s*(?:pack|box|bundle|case)|elite\s*trainer|etb|trainer\s*box|premium\s*collection|build\s*&?\s*battle|sleeved\s*booster|theme\s*deck|tin|mini\s*tin)\b/i.test(rawLc) ||
          /\bcontains?\s*\d+\s*(?:booster|pack|card)/i.test(rawLc);
        var cardSignals  =
          /\b(stage\s*[12]|basic\s*pok[eé]mon|hp\s*\d+|evolves\s*from|weakness|resistance)\b/i.test(rawLc);
        var productMode = productSignals && !cardSignals;
        // Build a token set from the OCR text + the parsed card name
        // (parsed name catches "Charizard" even if it didn't survive
        // into the dirty fullOcrText slice we see in logs).
        var STOP = new Set([
          'the','and','for','from','with','your','this','that','have','will','can',
          'pokemon','pokémon','tcg','card','cards','tm','copyright','nintendo','game',
          'freak','creatures','gamefreak','illus','illustrator','rare','common','uncommon',
          'inc','llc','ltd','japan','japanese','english','en','jp',
          'box','pack','booster','elite','trainer','sealed', // generic product words — too broad
          'additional','contains','volume','vol','edition'    // OCR'd off product packaging
        ]);
        function _tok(s) {
          return String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        }
        var queryTokens = new Set();
        _tok(fullOcrText).forEach(function(t) { if (!STOP.has(t)) queryTokens.add(t); });
        _tok(parsedName).forEach(function(t) { if (!STOP.has(t)) queryTokens.add(t); });
        if (queryTokens.size === 0) return [];

        // Detect single-card product_type values so we can EXCLUDE
        // them in product-mode. Anything that isn't a single is
        // treated as eligible (sealed-*, funko_pop, manga, plush,
        // statue, poster, tcg_single is the OPPOSITE — exclude that
        // too). Default to NOT a single when product_type is null
        // so old un-tagged rows can still surface.
        function _isSingle(c) {
          var pt = String(c && c.product_type || '').toLowerCase();
          return pt === 'single' || pt === 'tcg_single';
        }
        // Score every inventory row.
        var scored = [];
        collectionItems.forEach(function(c) {
          if (!c || c.is_ghost || c.sold_offline) return;
          if (!c.api_card_id) return; // need an api_card_id for _posSaleFromMatch routing
          // Product-mode: drop single cards entirely. Chaos Rising
          // booster scan was leaking single-card matches because
          // tokens like "evolution"/"chaos" overlap card names.
          if (productMode && _isSingle(c)) return;
          var nameToks = new Set(_tok(c.card_name));
          var setToks  = new Set(_tok(c.set_name));
          var numToks  = new Set(_tok(c.card_number));
          var nameHits = 0, totalHits = 0;
          queryTokens.forEach(function(q) {
            if (nameToks.has(q)) { nameHits++; totalHits++; return; }
            if (setToks.has(q) || numToks.has(q)) totalHits++;
          });
          // Require 2+ distinct query-token matches across name/set/number,
          // OR a single match that's specifically in the name (the
          // long-form name overlap is a strong signal even alone for
          // products like "Squishmallow Pikachu" → "Pikachu" in name).
          if (totalHits >= 2 || (nameHits >= 1 && nameToks.size <= 4)) {
            scored.push({
              row: c,
              score: totalHits * 10 + nameHits * 5 - (nameToks.size > 12 ? 2 : 0),
            });
          }
        });
        scored.sort(function(a, b) { return b.score - a.score; });

        // Shape to look like the catalog rows downstream code expects.
        var seenId = new Set();
        var out = [];
        for (var i = 0; i < scored.length && out.length < 8; i++) {
          var c = scored[i].row;
          var id = c.api_card_id;
          if (seenId.has(id)) continue;
          seenId.add(id);
          out.push({
            id:          id,
            name:        c.card_name || '?',
            set_name:    c.set_name || '',
            set_code:    c.set_code || '',
            card_number: c.card_number || '',
            rarity:      c.rarity || null,
            image_url:   c.card_image_url || '',
            similarity:  0.95 - (i * 0.02), // fake score so they sort top-down
            _ocr:        true,
            _posFallback: true,
          });
        }
        console.log('[Scanner] POS inventory fallback:', out.length, 'matches from', queryTokens.size, 'query tokens',
          productMode ? '(product-mode — singles excluded)' : '(general — all product types eligible)');
        return out;
      } catch (e) {
        console.warn('[Scanner] POS fallback failed:', e);
        return [];
      }
    }

    // approach mirrors the TCG detector — keyword + format signals,
    // highest score wins, falls back to 'other' (manual entry) when
    // none score a confident hit.
    function detectProductType(text) {
      if (!text) return 'other';
      var t = text.toLowerCase();
      var scores = { funko_pop: 0, manga: 0, poster: 0, plush: 0, statue: 0, sealed: 0 };

      // Sealed TCG product — booster boxes / packs / ETBs / tins /
      // theme decks across Pokemon / MTG / YGO / OP / Gundam.
      // Strong brand signals layered with packaging-format keywords.
      // The packaging-format hits are 2+ each so any single confident
      // match clears the threshold without needing brand confirmation.
      if (/\b(booster\s*(?:pack|box|bundle|case|display))\b/i.test(t)) scores.sealed += 3;
      if (/\b(elite\s*trainer\s*box|etb)\b/i.test(t))                  scores.sealed += 3;
      if (/\b(ultra\s*premium\s*collection|upc)\b/i.test(t))           scores.sealed += 3;
      if (/\b(premium\s*collection|special\s*collection|collection\s*box)\b/i.test(t)) scores.sealed += 3;
      if (/\badditional\s*game\s*cards?\b/i.test(t))                   scores.sealed += 3;
      if (/\b(theme\s*deck|starter\s*deck|structure\s*deck|battle\s*deck|build[\s-]?(?:and|&)[\s-]?battle)\b/i.test(t)) scores.sealed += 3;
      if (/\b(mini\s*tin|trainer\s*tin|collector\s*tin|tin\s*box)\b/i.test(t)) scores.sealed += 3;
      if (/\b(set\s*booster|draft\s*booster|collector\s*booster|jumpstart\s*booster|play\s*booster|commander\s*deck|planeswalker\s*deck|secret\s*lair|fat\s*pack)\b/i.test(t)) scores.sealed += 3;
      if (/\b(gift\s*bundle|holiday\s*bundle)\b/i.test(t))             scores.sealed += 3;
      // Brand markers — confirm the TCG. Each one is small (1) so
      // they don't trip the threshold on their own (a single card
      // also says "Pokemon"), but they boost a packaging-format hit
      // from 3 → 4 which beats Funko's brand-only hit at 3.
      if (/\bpok[eé]mon\b/i.test(t))      scores.sealed += 1;
      if (/\bmagic.{0,4}the.{0,4}gathering|\bmtg\b/i.test(t)) scores.sealed += 1;
      if (/\byu-?gi-?oh|\bygo\b/i.test(t)) scores.sealed += 1;
      if (/\bone\s*piece\b/i.test(t))     scores.sealed += 1;
      if (/\bgundam\b/i.test(t) && /\bcard\b/i.test(t)) scores.sealed += 1;
      // Negative signal — if the OCR contains card-specific markers,
      // dial sealed back so a single-card OCR that happens to say
      // "Booster" in its rules text doesn't mis-classify.
      if (/\b(stage\s*[12]|basic\s*pok[eé]mon|hp\s*\d{2,3}|evolves\s*from|weakness\s*[×x]|resistance|retreat\s*cost)\b/i.test(t)) scores.sealed = Math.max(0, scores.sealed - 4);

      // Funko — already-strong brand signal
      if (/\bfunko\b/i.test(t))           scores.funko_pop += 3;
      if (/\bpop\s*!/i.test(t))           scores.funko_pop += 2;
      if (/vinyl\s*figure/i.test(t))      scores.funko_pop += 2;

      // Manga — publisher + volume markers
      if (/\bvol\.?\s*\d+/i.test(text))   scores.manga += 2;
      if (/\bvolume\s*\d+/i.test(text))   scores.manga += 2;
      if (/\b(viz\s*media|tokyopop|kodansha|seven\s*seas|yen\s*press|dark\s*horse|udon)\b/i.test(t)) scores.manga += 3;
      if (/\bmanga\b/i.test(t))           scores.manga += 1;
      if (/\b(shonen\s*jump|shojo|seinen|josei)\b/i.test(t)) scores.manga += 2;
      if (/\b(isbn|published|translation)\b/i.test(t)) scores.manga += 1;

      // Posters / art prints — limited edition + artist credit signals
      if (/\b(limited\s*edition|signed\s*print|art\s*print|giclee|screen\s*print)\b/i.test(t)) scores.poster += 3;
      if (/\bedition\s*of\s*\d+/i.test(text)) scores.poster += 3;
      if (/\b\d+\/\d{2,4}\b/.test(text) && /print|edition|poster/i.test(t)) scores.poster += 2; // edition fraction "12/250"
      if (/\bposter\b/i.test(t))          scores.poster += 1;
      if (/\bmondo\b/i.test(t))           scores.poster += 2; // famous poster publisher

      // Plush — brand tags + soft-toy keywords
      if (/\b(plush|stuffed|cuddl|soft\s*toy)\b/i.test(t)) scores.plush += 3;
      if (/\b(jellycat|squishmallow|build[-\s]?a[-\s]?bear|pokemon\s*center)\b/i.test(t)) scores.plush += 2;
      if (/\b(polyester|cotton)\s*fill/i.test(t)) scores.plush += 1;
      if (/\bsurface\s*wash\b/i.test(t))  scores.plush += 1; // common care label

      // Statues / non-Funko figures — scale + brand markers
      if (/\b1\s*\/\s*(4|6|7|8|10|12)\b/.test(text)) scores.statue += 3; // "1/7 scale"
      if (/\bscale\b/i.test(t) && /\bfigure\b/i.test(t)) scores.statue += 2;
      if (/\b(banpresto|kotobukiya|good\s*smile|max\s*factory|mcfarlane|sideshow|prime\s*1|first\s*4\s*figures)\b/i.test(t)) scores.statue += 3;
      if (/\b(prize\s*figure|sff|nendoroid|figma)\b/i.test(t)) scores.statue += 2;
      if (/\bpvc\b/i.test(t) && /\bfigure\b/i.test(t)) scores.statue += 1;

      // Pick winner. Threshold 2 to claim — below that we say 'other'
      // and let the shop pick from the listing form.
      var best = 'other', bestN = 0;
      ['funko_pop','manga','poster','plush','statue','sealed'].forEach(function(g) {
        if (scores[g] > bestN && scores[g] >= 2) { best = g; bestN = scores[g]; }
      });
      try { console.log('[product detect]', JSON.stringify(scores), '→', best); } catch(_) {}
      return best;
    }

    // Sealed TCG packaging extractor — pulls game type, packaging
    // format (booster_pack / etb / tin / etc), and set/series name
    // from the OCR'd box text. Maps cleanly to the catalog's
    // product_type column populated by sync_sealed_products.py
    // (see SEALED_PATTERNS in that file for the canonical list).
    function _extractSealedFromOcr(text) {
      if (!text) return {};
      var out = {};
      var rawLc = text.toLowerCase();

      // ── Game type detection (TCG brand) ─────────────────────────────
      if (/\bpok[eé]mon\b/i.test(rawLc))               out.game_type = 'pokemon';
      else if (/\bmagic.{0,4}the.{0,4}gathering|\bmtg\b/i.test(rawLc)) out.game_type = 'mtg';
      else if (/\byu-?gi-?oh|\bygo\b/i.test(rawLc))    out.game_type = 'yugioh';
      else if (/\bone\s*piece\b/i.test(rawLc))         out.game_type = 'onepiece';
      else if (/\bgundam\b/i.test(rawLc))              out.game_type = 'gundam';
      else if (/\bdragon\s*ball\b/i.test(rawLc))       out.game_type = 'dbz';

      // ── Packaging format (matches catalog.product_type values
      //     populated by sync_sealed_products.py / SEALED_PATTERNS).
      //     Most-specific first, generic fallbacks last so MTG's
      //     "set booster" doesn't get clobbered by bare "booster".
      var FMT = [
        [/\b(ultra\s*premium\s*collection|upc)\b/i,                 'utb'],
        [/\belite\s*trainer\s*box\b|\betb\b/i,                       'etb'],
        [/\b(premium\s*collection|special\s*collection|collection\s*box)\b/i, 'premium_collection'],
        [/\bset\s*booster\b/i,           'set_booster'],
        [/\bdraft\s*booster\b/i,         'draft_booster'],
        [/\bcollector\s*booster\b/i,     'collector_booster'],
        [/\bjumpstart\s*booster\b/i,     'jumpstart_booster'],
        [/\bplay\s*booster\b/i,          'play_booster'],
        [/\bcommander\s*deck\b/i,        'commander_deck'],
        [/\bplaneswalker\s*deck\b/i,     'planeswalker_deck'],
        [/\bsecret\s*lair\b/i,           'secret_lair'],
        [/\bfat\s*pack\b/i,              'bundle'],
        [/\bbooster\s*box\b|\bdisplay\s*box\b/i, 'booster_box'],
        [/\bbooster\s*pack\b/i,          'booster_pack'],
        [/\bbooster\s*bundle\b/i,        'booster_bundle'],
        [/\b(gift|holiday)\s*bundle\b/i, 'gift_bundle'],
        [/\bbundle\b/i,                  'bundle'],
        [/\b(league\s*battle|battle)\s*deck\b/i, 'battle_deck'],
        [/\bstructure\s*deck\b/i,        'structure_deck'],
        [/\bstarter\s*deck\b|\bpreconstructed\s*deck\b/i, 'starter_deck'],
        [/\btheme\s*deck\b/i,            'theme_deck'],
        [/\bbuild\s*(?:and|&)\s*battle\b|\bbuild[-\s]?a[-\s]?deck\b/i, 'build_and_battle'],
        [/\bmini\s*tin\b/i,              'tin_mini'],
        [/\btin\b/i,                     'tin'],
        [/\bdeck\b/i,                    'deck'],
      ];
      for (var i = 0; i < FMT.length; i++) {
        if (FMT[i][0].test(rawLc)) { out.product_subtype = FMT[i][1]; break; }
      }

      // ── Set / series name candidates — extract MULTIPLE prominent
      //     all-caps phrases and score them by length + known
      //     set-name buzzword density. Pokemon boxes often have
      //     multiple all-caps lines: brand row (POKEMON), tagline
      //     (MEGA EVOLUTION), and set name (CHAOS RISING). OCR can
      //     also garble short lines into noise ("KU GAM" from
      //     "GU GAM" / "CARD GAME"), so we can't trust "the first
      //     line that's all-caps". Instead we score and pick the
      //     best one for the headline `set_name`, then keep the rest
      //     as fallback `set_name_candidates` for the catalog query
      //     to fan out across.
      var STOPLINES = /^(pok[eé]mon|magic\s*the\s*gathering|mtg|yu-?gi-?oh|one\s*piece|trading\s*card\s*game|tcg|game|cards?|additional\s*game\s*cards?|expansion|series|edition|\d+\s*\+?\s*$)$/i;
      // Recognized set-name buzzwords across Pokemon / MTG / OP /
      // YGO / Gundam. Hitting any of these signals "this line is
      // very likely a real set name" — boosts the candidate's score
      // above garbled OCR fragments. Maintained as a flat list so
      // adding new releases is one-line additions.
      var SET_BUZZWORDS = [
        'evolution','evolutions','rising','ascent','arena','fates','flames','horizons',
        'paradox','obsidian','paldean','scarlet','violet','stellar','crown','crowned',
        'temporal','prismatic','surging','sparks','sword','shield','rebel','clash',
        'darkness','ablaze','vivid','voltage','battle','styles','chilling','reign',
        'evolving','skies','fusion','strike','brilliant','stars','astral','radiance',
        'lost','origin','silver','tempest','crown','zenith','journey','together',
        'mega','base','jungle','fossil','rocket','gym','neo','genesis','discovery',
        'destiny','aquapolis','expedition','ruby','sapphire','dragon','majesty',
        'celebrations','classic','hidden','unbroken','bonds','cosmic','eclipse',
        'champions','path','vivid','chaos','dark','ancient','origins','primal',
        'phantom','forces','flashfire','xy','black','white','bw','sun','moon','sm',
        'sv','swsh',
        // MTG
        'commander','foundations','duskmourn','outlaws','thunder','junction','murders',
        'karlov','manor','ravnica','kamigawa','dominaria','innistrad','strixhaven',
        // OP
        'romance','dawn','paramount','pillars','kingdoms','intrigue','warlords','legacy',
        'master','azure','seven','will','carrying','newtype','phantom','steel','requiem',
        // YGO
        'magnificent','mavens','quarter','century','tactical','masters','dimension',
        'force','legendary','duelists','toon','chaos','phantom','rage',
        // Gundam (generic terms)
        'mobile','suit','newtype','crossover','phantom',
      ];
      var BUZZ = new Set(SET_BUZZWORDS);
      var candidates = [];
      text.split('\n').forEach(function(l) {
        var line = l.trim();
        if (!line || line.length < 3) return;
        if (STOPLINES.test(line)) return;
        var letters = line.replace(/[^A-Za-z]/g, '');
        if (letters.length < 3) return;
        var upperLetters = letters.replace(/[^A-Z]/g, '');
        var upperRatio = upperLetters.length / letters.length;
        var wordCount = line.split(/\s+/).length;
        // Mostly-upper, reasonable word count.
        if (wordCount > 5 || upperRatio < 0.6) return;
        // Score:
        //   +5 per buzzword hit (strongest signal — known set vocabulary)
        //   +2 per word (longer phrases beat single-word garbage)
        //   +1 for length > 10 (real set names tend to be longer)
        //   -3 per all-uppercase 2-letter "word" (OCR garbage like "KU")
        var score = 0;
        var toks = line.toLowerCase().match(/[a-z]+/g) || [];
        toks.forEach(function(t) {
          if (BUZZ.has(t)) score += 5;
          if (t.length === 2 && /^[A-Z]+$/.test(t.toUpperCase())) score -= 3;
        });
        score += wordCount * 2;
        if (letters.length > 10) score += 1;
        if (score > 0) candidates.push({ line: line.replace(/\s+/g, ' ').trim(), score: score });
      });
      candidates.sort(function(a, b) { return b.score - a.score; });
      if (candidates.length) {
        out.set_name = candidates[0].line;
        // Keep the next few as fallback search terms — the catalog
        // query will fan out across all of them. "MEGA EVOLUTION" and
        // "CHAOS RISING" both being present on the same box means the
        // catalog row could match either depending on how the upstream
        // sealed sync named it.
        out.set_name_candidates = candidates.slice(0, 4).map(function(c) { return c.line; });
      }

      // ── Pack quantity ("36 PACKS", "10 ADDITIONAL CARDS") —
      //     useful both as a distinguishing detail and as a
      //     packaging-type tiebreaker.
      var qtyM = text.match(/\b(\d{1,3})\s*(?:additional\s*)?(?:cards?|packs?|boosters?)\b/i);
      if (qtyM) out.contents_qty = parseInt(qtyM[1], 10);

      return out;
    }

    // ── Sealed catalog match ────────────────────────────────────────
    // Takes the structured output of _extractSealedFromOcr and looks
    // up matching catalog rows. Scopes by game_type when known,
    // narrows by product_type when extractable, and scores rows by
    // set-name token overlap. Returns up to 8 candidates shaped like
    // the regular scan-result rows so showScanResults can render
    // them with no changes.
    //
    // Three-tier lookup strategy (gracefully degrades when an upstream
    // sealed sync hasn't tagged rows perfectly):
    //   1. game_type + product_type + name ilike set_name
    //   2. game_type + name ilike set_name (drop product_type)
    //   3. name ilike set_name (drop game_type — last resort)
    async function _matchSealedInCatalog(extracted) {
      try {
        if (!extracted) return [];
        // Fan out across ALL set-name candidates so a misranked
        // headline ("KU GAM" outranking "CHAOS RISING") doesn't kill
        // the whole search. We try each candidate against the same
        // three-tier filter cascade, then de-dupe matched rows by
        // id and score by combined name-token overlap.
        var candidates = (extracted.set_name_candidates && extracted.set_name_candidates.length)
          ? extracted.set_name_candidates
          : (extracted.set_name ? [extracted.set_name] : []);
        if (candidates.length === 0) return [];
        var game  = extracted.game_type || null;
        var ptype = extracted.product_subtype || null;
        // Build the catalog base query
        function _base() {
          // product_type single must be excluded — we're scanning
          // packaging, not cards.
          return sb.from('catalog')
            .select('id,name,set_name,set_code,card_number,rarity,image_url,product_type,game_type')
            .neq('product_type', 'single')
            .neq('product_type', 'tcg_single');
        }
        // Run all three tiers per candidate, searching BOTH `name`
        // AND `set_name` columns. Subset/parent-set layouts are
        // common — "Mega Evolution" is the parent set and "Chaos
        // Rising" is the subset, so the catalog row could store the
        // subset name in `name` and the parent in `set_name`, or
        // vice-versa, depending on how the sync ingested it. We OR
        // both columns so either layout surfaces. Escape commas in
        // the search term because PostgREST treats `,` as a clause
        // separator inside `.or(...)`.
        function _escOr(s) { return String(s || '').replace(/,/g, ''); }
        var allRows = [];
        for (var ci = 0; ci < candidates.length; ci++) {
          var name = candidates[ci];
          var safe = _escOr(name);
          var orClause = 'name.ilike.%' + safe + '%,set_name.ilike.%' + safe + '%';
          // Tier 1 — strictest filter
          if (game && ptype) {
            var r1 = await _base().eq('game_type', game).eq('product_type', ptype)
              .or(orClause).limit(15);
            if (!r1.error && r1.data) Array.prototype.push.apply(allRows, r1.data);
          }
          // Tier 2 — drop product_type
          if (game) {
            var r2 = await _base().eq('game_type', game)
              .or(orClause).limit(15);
            if (!r2.error && r2.data) Array.prototype.push.apply(allRows, r2.data);
          }
          // Tier 3 — drop game_type (only as a last resort, after
          // all candidates exhausted, since cross-TCG name overlap
          // is real — "Booster Box" alone matches every game).
          if (allRows.length === 0 && ci === candidates.length - 1) {
            var r3 = await _base().or(orClause).limit(15);
            if (!r3.error && r3.data) Array.prototype.push.apply(allRows, r3.data);
          }
        }
        // De-dupe by id
        var seenRow = new Set();
        var rows = [];
        allRows.forEach(function(r) {
          if (r && r.id && !seenRow.has(r.id)) { seenRow.add(r.id); rows.push(r); }
        });
        if (rows.length === 0) return [];

        // Score by extra token overlap in name + set_name, so the
        // "Pokemon TCG: Chaos Rising Booster Pack" row beats
        // "Chaos Rising Build & Battle" when ptype is booster_pack.
        // Tokens come from ALL candidate phrases so a row that
        // contains "Chaos" but not "Mega Evolution" still scores on
        // the Chaos hit alone.
        var qSet = new Set();
        candidates.forEach(function(cand) {
          (String(cand).toLowerCase().match(/[a-z0-9]{3,}/g) || []).forEach(function(t) { qSet.add(t); });
        });
        rows.forEach(function(r) {
          var hay = ((r.name || '') + ' ' + (r.set_name || '')).toLowerCase();
          var hayToks = hay.match(/[a-z0-9]{3,}/g) || [];
          var hits = 0;
          hayToks.forEach(function(h) { if (qSet.has(h)) hits++; });
          // Bonus for matching product_type when we know it
          var ptypeBonus = (ptype && r.product_type === ptype) ? 5 : 0;
          r._score = hits + ptypeBonus;
        });
        rows.sort(function(a, b) { return b._score - a._score; });

        return rows.slice(0, 8).map(function(r, i) {
          return {
            id:          r.id,
            name:        r.name || '?',
            set_name:    r.set_name || '',
            set_code:    r.set_code || '',
            card_number: r.card_number || '',
            rarity:      r.rarity || null,
            image_url:   r.image_url || '',
            similarity:  0.95 - (i * 0.03),
            _ocr:        true,
            _sealed:     true,
            _productType: r.product_type || null,
          };
        });
      } catch (e) {
        console.warn('[sealed match] catalog lookup failed:', e);
        return [];
      }
    }

    // ── Per-category extractors ─────────────────────────────────────────
    // Each returns a best-effort partial { title, ...categorySpecific }
    // that maps to the listing form. The router in _runProductScan picks
    // the right extractor based on detectProductType().

    function _extractMangaFromOcr(text) {
      if (!text) return {};
      var out = {};
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      // Volume number — "Vol. 5" / "Volume 12" / just "Vol 3"
      var volMatch = text.match(/\bvol\.?\s*(\d+)/i) || text.match(/\bvolume\s*(\d+)/i);
      if (volMatch) out.volume = parseInt(volMatch[1], 10);
      // Publisher (well-known manga publishers)
      var PUBLISHERS = [
        ['VIZ Media','VIZ Media'], ['VIZ','VIZ Media'],
        ['Tokyopop','Tokyopop'], ['Kodansha','Kodansha'],
        ['Seven Seas','Seven Seas'], ['Yen Press','Yen Press'],
        ['Dark Horse','Dark Horse'], ['Udon','Udon Entertainment'],
        ['Square Enix','Square Enix Manga'],
      ];
      for (var i = 0; i < PUBLISHERS.length; i++) {
        if (text.toLowerCase().indexOf(PUBLISHERS[i][0].toLowerCase()) >= 0) {
          out.publisher = PUBLISHERS[i][1]; break;
        }
      }
      // Title — usually the largest line; skip publisher / vol / barcode
      var SKIP = /^(VIZ|TOKYOPOP|KODANSHA|YEN\s*PRESS|DARK\s*HORSE|UDON|VOL\.?\s*\d+|VOLUME\s*\d+|ISBN|\d+|©|MANGA)$/i;
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.length < 3 || ln.length > 50) continue;
        if (SKIP.test(ln)) continue;
        if (!/[A-Za-z]/.test(ln)) continue;
        if (/isbn|barcode|©|tm/i.test(ln)) continue;
        out.title = ln; break;
      }
      return out;
    }

    function _extractPosterFromOcr(text) {
      if (!text) return {};
      var out = {};
      // Edition fraction "12/250"
      var edMatch = text.match(/\b(\d+)\s*\/\s*(\d{2,4})\b/);
      if (edMatch) { out.edition_number = parseInt(edMatch[1], 10); out.edition_total = parseInt(edMatch[2], 10); }
      // "Edition of 250" / "Limited edition"
      if (/\blimited\s*edition\b/i.test(text)) out.limited = true;
      if (/\bsigned\b/i.test(text)) out.signed = true;
      // Famous publishers / studios
      if (/\bmondo\b/i.test(text)) out.publisher = 'Mondo';
      // Title — first long line that isn't an edition number or numeric
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.length < 4 || ln.length > 60) continue;
        if (!/[A-Za-z]/.test(ln)) continue;
        if (/^\d/.test(ln)) continue;
        if (/edition|signed|©|mondo|print/i.test(ln)) continue;
        out.title = ln; break;
      }
      return out;
    }

    function _extractPlushFromOcr(text) {
      if (!text) return {};
      var out = {};
      // Brand
      var BRANDS = [
        ['Jellycat','Jellycat'], ['Squishmallow','Squishmallow'],
        ['Build-A-Bear','Build-A-Bear'], ['Pokemon Center','Pokemon Center'],
        ['Sanrio','Sanrio'], ['Banpresto','Banpresto'],
      ];
      for (var i = 0; i < BRANDS.length; i++) {
        if (text.toLowerCase().indexOf(BRANDS[i][0].toLowerCase()) >= 0) {
          out.brand = BRANDS[i][1]; break;
        }
      }
      // Size — "12 inch" / "30cm" / "Small/Medium/Large"
      var sizeMatch = text.match(/\b(\d{1,3})\s*(inch|in|cm|"|')\b/i);
      if (sizeMatch) out.size = sizeMatch[1] + ' ' + sizeMatch[2];
      else {
        var labelSize = text.match(/\b(small|medium|large|xl|jumbo|mini)\b/i);
        if (labelSize) out.size = labelSize[1];
      }
      // Character / item name — first long non-skip line
      var SKIP = /^(JELLYCAT|SQUISHMALLOW|POKEMON\s*CENTER|SANRIO|©|TM|SMALL|MEDIUM|LARGE|XL|JUMBO|MINI|\d+\s*(?:INCH|CM)|CARE)$/i;
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.length < 3 || ln.length > 40) continue;
        if (SKIP.test(ln)) continue;
        if (!/[A-Za-z]/.test(ln)) continue;
        out.character = ln; break;
      }
      return out;
    }

    function _extractStatueFromOcr(text) {
      if (!text) return {};
      var out = {};
      // Scale — "1/7 Scale" / "1:6"
      var scaleMatch = text.match(/\b1\s*[\/:]\s*(\d{1,2})\b/);
      if (scaleMatch) out.scale = '1/' + scaleMatch[1];
      // Brand / manufacturer
      var BRANDS = [
        ['Banpresto','Banpresto'], ['Kotobukiya','Kotobukiya'],
        ['Good Smile','Good Smile Company'], ['Max Factory','Max Factory'],
        ['McFarlane','McFarlane Toys'], ['Sideshow','Sideshow Collectibles'],
        ['Prime 1','Prime 1 Studio'], ['First 4 Figures','First 4 Figures'],
        ['Bandai','Bandai'], ['SH Figuarts','S.H. Figuarts'],
        ['Nendoroid','Good Smile (Nendoroid)'], ['figma','Max Factory (figma)'],
      ];
      for (var i = 0; i < BRANDS.length; i++) {
        if (text.toLowerCase().indexOf(BRANDS[i][0].toLowerCase()) >= 0) {
          out.brand = BRANDS[i][1]; break;
        }
      }
      // Series — common franchise keywords (reuse the Funko list — overlap is fine)
      var SERIES_KEYWORDS = [
        ['DRAGON BALL','Dragon Ball'], ['ONE PIECE','One Piece'],
        ['NARUTO','Naruto'], ['MY HERO ACADEMIA','My Hero Academia'],
        ['ATTACK ON TITAN','Attack on Titan'], ['JUJUTSU KAISEN','Jujutsu Kaisen'],
        ['DEMON SLAYER','Demon Slayer'], ['CHAINSAW MAN','Chainsaw Man'],
        ['MARVEL','Marvel'], ['DC COMICS','DC Comics'],
      ];
      for (var s = 0; s < SERIES_KEYWORDS.length; s++) {
        if (text.toUpperCase().indexOf(SERIES_KEYWORDS[s][0]) >= 0) {
          out.series = SERIES_KEYWORDS[s][1]; break;
        }
      }
      // Character — first long line that's not a brand / scale / series
      var SKIP_PAT = /^(BANPRESTO|KOTOBUKIYA|GOOD\s*SMILE|MAX\s*FACTORY|MCFARLANE|SIDESHOW|PRIME\s*1|BANDAI|©|TM|PVC|SCALE|1\s*\/\s*\d+|\d+\s*MM)$/i;
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        if (ln.length < 2 || ln.length > 40) continue;
        if (SKIP_PAT.test(ln)) continue;
        if (!/[A-Za-z]/.test(ln)) continue;
        out.character = ln; break;
      }
      return out;
    }

    // ── Shop Product Scanner — completely separate from card scanner ──
    // Tier-gated to 'shop'. Reuses the existing camera capture + GCV OCR
    // helpers but routes results through category-specific extractors.
    // For the Funko pilot it shows the OCR text and the parsed Funko fields
    // so the shop can paste them into the listing form (autofill wiring
    // comes in the next step once the extractor is dialed in).
    //
    // CRITICAL: this never touches runMatch, parseCardName, or any of the
    // card-scanner code paths. They share only the low-level ocrCardText
    // helper, which is a pure function with no side effects.
    window.openProductScanner = async function() {
      // Tier gate — only shop tier and above
      var tier = (currentUser && currentUser.subscription_tier) || '';
      var isAdmin = currentUser && currentUser.is_admin;
      if (tier !== 'shop' && !isAdmin) {
        showToast('Product scanner is a Shop tier feature.');
        return;
      }

      // Build a fresh modal each call (simpler than maintaining state)
      document.getElementById('productScannerModal')?.remove();
      var modal = document.createElement('div');
      modal.id = 'productScannerModal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:100020;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px';
      modal.innerHTML = '' +
        '<div style="position:relative;width:100%;max-width:520px;background:var(--surface);border:2px solid var(--copper-dim);border-radius:6px;padding:18px 18px 22px;max-height:92svh;overflow-y:auto;box-shadow:0 0 30px var(--copper-glow)">' +
          '<button onclick="document.getElementById(\'productScannerModal\').remove()" style="position:absolute;top:10px;right:14px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--muted)">×</button>' +
          '<div style="font-size:.55rem;letter-spacing:.14em;color:var(--copper);margin-bottom:6px">◈ PRODUCT SCANNER · SHOP TIER</div>' +
          '<div style="font-size:.8rem;color:var(--text);font-weight:700;margin-bottom:14px">Scan a product</div>' +
          '<div style="font-size:.65rem;color:var(--muted);margin-bottom:12px;line-height:1.5">Take a photo of the front. We&apos;ll detect the category and auto-extract the listing fields. Supported: Funko Pop, manga, posters, plush, statues.</div>' +
          '<input type="file" accept="image/*" capture="environment" id="productScannerFile" style="display:none" onchange="_runProductScan(this)">' +
          '<button onclick="document.getElementById(\'productScannerFile\').click()" style="width:100%;padding:14px;border:1.5px solid var(--accent);background:rgba(26,199,160,.08);color:var(--accent);font-family:\'Space Mono\',monospace;font-size:.85rem;font-weight:700;cursor:pointer;letter-spacing:.06em">TAKE PHOTO</button>' +
          '<div id="productScanResult" style="margin-top:14px"></div>' +
        '</div>';
      document.body.appendChild(modal);
    };

    window._runProductScan = async function(fileInput) {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var resultEl = document.getElementById('productScanResult');
      if (resultEl) resultEl.innerHTML = '<div style="font-size:.7rem;color:var(--muted);padding:8px 0">// Reading box…</div>';

      // Convert file to data URL and pass to the existing GCV helper.
      // ocrCardText() is pure — it doesn't trigger any card-scanner code paths.
      var reader = new FileReader();
      reader.onload = async function(e) {
        var dataURL = e.target.result;
        var text = await ocrCardText(dataURL);
        if (!text) {
          if (resultEl) resultEl.innerHTML = '<div style="font-size:.7rem;color:var(--red);padding:8px 0">No text detected. Try a clearer photo of the box front.</div>';
          return;
        }

        // Route to the right extractor based on what we OCR'd. Detector
        // scores keyword / format signals per category; falls back to
        // funko_pop (the original pilot) when nothing scores confidently.
        var ptype = detectProductType(text);
        var extracted;
        switch (ptype) {
          case 'sealed':    extracted = _extractSealedFromOcr(text); break;
          case 'manga':     extracted = _extractMangaFromOcr(text);  break;
          case 'poster':    extracted = _extractPosterFromOcr(text); break;
          case 'plush':     extracted = _extractPlushFromOcr(text);  break;
          case 'statue':    extracted = _extractStatueFromOcr(text); break;
          case 'funko_pop': extracted = _extractFunkoFromOcr(text);  break;
          default:
            // 'other' — try Funko anyway as the most likely case, then
            // fall through to manual entry if it returns nothing.
            extracted = _extractFunkoFromOcr(text);
            if (!Object.keys(extracted).length) ptype = 'other';
        }
        var hasAny = Object.keys(extracted).length > 0;

        // Sealed: kick off catalog match in parallel with the field
        // display so candidates surface as fast as possible. Stored
        // on the stash for the action-button handlers.
        var _sealedCandidatesP = (ptype === 'sealed' && hasAny)
          ? _matchSealedInCatalog(extracted)
          : Promise.resolve([]);

        // Display label for the detected category
        var TYPE_LABELS = {
          funko_pop: 'FUNKO POP', manga: 'MANGA', poster: 'POSTER / ART PRINT',
          plush: 'PLUSH', statue: 'STATUE / FIGURE', sealed: 'SEALED TCG PRODUCT',
          other: 'OTHER PRODUCT'
        };
        var typeLabel = TYPE_LABELS[ptype] || 'PRODUCT';

        var html = '';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
        html += '<div style="font-size:.55rem;letter-spacing:.1em;color:var(--accent)">EXTRACTED</div>';
        html += '<div style="font-size:.55rem;letter-spacing:.12em;color:var(--copper)">◆ ' + typeLabel + '</div>';
        html += '</div>';

        if (hasAny) {
          html += '<div style="border:1px solid var(--border);background:var(--surface2);padding:10px 12px;margin-bottom:12px">';
          // Category-specific field display. Each row is " <strong>Label:</strong> value"
          // with the same teal/muted color treatment regardless of category
          // so the panel feels consistent across product types.
          function _row(label, val, accent) {
            if (val == null || val === '' || val === false) return;
            var color = accent ? 'var(--copper)' : 'var(--muted)';
            html += '<div style="font-size:.7rem;color:' + color + ';margin-top:3px"><strong>' + label + ':</strong> ' + _escHtml(String(val)) + '</div>';
          }
          if (ptype === 'funko_pop') {
            if (extracted.character)  html += '<div style="font-size:.75rem;color:var(--text)"><strong>Character:</strong> ' + _escHtml(extracted.character) + '</div>';
            _row('Series',    extracted.series);
            _row('Pop #',     extracted.pop_number);
            _row('Exclusive', extracted.exclusive);
            if (extracted.is_chase) html += '<div style="font-size:.7rem;color:var(--copper);margin-top:3px"><strong>◆ Chase variant detected</strong></div>';
          } else if (ptype === 'manga') {
            if (extracted.title) html += '<div style="font-size:.75rem;color:var(--text)"><strong>Title:</strong> ' + _escHtml(extracted.title) + '</div>';
            _row('Volume',    extracted.volume);
            _row('Publisher', extracted.publisher);
          } else if (ptype === 'poster') {
            if (extracted.title) html += '<div style="font-size:.75rem;color:var(--text)"><strong>Title:</strong> ' + _escHtml(extracted.title) + '</div>';
            _row('Publisher', extracted.publisher);
            if (extracted.edition_number && extracted.edition_total) {
              _row('Edition', extracted.edition_number + ' of ' + extracted.edition_total, true);
            }
            if (extracted.limited) _row('Limited Edition', 'yes', true);
            if (extracted.signed)  _row('Signed',          'yes', true);
          } else if (ptype === 'plush') {
            if (extracted.character) html += '<div style="font-size:.75rem;color:var(--text)"><strong>Name:</strong> ' + _escHtml(extracted.character) + '</div>';
            _row('Brand', extracted.brand);
            _row('Size',  extracted.size);
          } else if (ptype === 'statue') {
            if (extracted.character) html += '<div style="font-size:.75rem;color:var(--text)"><strong>Character:</strong> ' + _escHtml(extracted.character) + '</div>';
            _row('Series', extracted.series);
            _row('Brand',  extracted.brand);
            _row('Scale',  extracted.scale, true);
          } else if (ptype === 'sealed') {
            if (extracted.set_name) html += '<div style="font-size:.75rem;color:var(--text)"><strong>Set:</strong> ' + _escHtml(extracted.set_name) + '</div>';
            // Show the other candidate phrases so it's clear what
            // we're searching the catalog against — useful when the
            // first-ranked "Set" turns out to be OCR garbage and the
            // real hit comes from a lower-ranked candidate.
            if (extracted.set_name_candidates && extracted.set_name_candidates.length > 1) {
              var others = extracted.set_name_candidates.slice(1).join(' · ');
              _row('Also tried', others);
            }
            _row('TCG',          (extracted.game_type || '').replace('mtg','Magic').replace('pokemon','Pokemon').replace('onepiece','One Piece').replace('yugioh','Yu-Gi-Oh').replace('gundam','Gundam').replace('dbz','Dragon Ball'));
            _row('Format',       (extracted.product_subtype || '').replace(/_/g,' ').replace(/\b\w/g, function(s){return s.toUpperCase();}));
            _row('Contents',     extracted.contents_qty ? extracted.contents_qty + ' cards/packs' : '');
          }
          html += '</div>';

          // Sealed: dedicated catalog-match panel. Renders empty
          // placeholder first, then fills in when _sealedCandidatesP
          // resolves. Each candidate is a tap-target that routes to
          // _confirmSealedAdd / _confirmSealedSale.
          if (ptype === 'sealed') {
            html += '<div id="sealedCandidates" style="margin-bottom:12px"><div style="font-size:.55rem;letter-spacing:.1em;color:var(--accent);margin-bottom:6px">CATALOG MATCHES</div><div style="font-size:.7rem;color:var(--muted);padding:8px 0">Searching catalog…</div></div>';
          }
        } else {
          html += '<div style="font-size:.7rem;color:var(--muted);margin-bottom:12px">No structured fields recognized — see raw OCR below to copy manually, or pick a category in the listing form.</div>';
        }

        // Raw OCR for fallback / debugging
        html += '<details style="margin-bottom:12px"><summary style="font-size:.6rem;color:var(--muted);cursor:pointer;letter-spacing:.06em">RAW OCR TEXT</summary>';
        html += '<pre style="margin-top:6px;background:var(--surface2);border:1px solid var(--border);padding:8px 10px;font-size:.6rem;color:var(--text);white-space:pre-wrap;max-height:200px;overflow-y:auto">' + _escHtml(text) + '</pre>';
        html += '</details>';

        // Stash the extracted + raw text + the original File + the
        // detected product type so the DONE button can route to the
        // right listing-modal prefill. The File is carried so the
        // listing modal pre-fills its photo slot — no re-upload needed.
        window._lastProductScan = { extracted: extracted, raw: text, file: file, ptype: ptype, candidates: [] };

        // Action row: RETAKE + ADD TO BINDER + LIST. Two distinct
        // paths because shops do both jobs: (a) bulk-populating
        // inventory from incoming product (ADD TO BINDER, no
        // marketplace listing yet) and (b) listing a one-off for
        // sale (LIST, opens the marketplace flow).
        // ADD TO BINDER works even without a catalog match — it
        // creates an inventory row with the extracted text as the
        // card_name so the shop's stock count is right, then admin
        // can link it to a catalog row later when one's synced.
        html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
        html += '<button onclick="document.getElementById(\'productScannerFile\').click()" style="flex:1 1 80px;padding:10px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:\'Space Mono\',monospace;font-size:.66rem;cursor:pointer">↻ RETAKE</button>';
        html += '<button onclick="_addProductToBinder()" style="flex:2 1 140px;padding:10px;border:1px solid var(--accent);background:var(--accent);color:var(--text-on-accent);font-family:\'Space Mono\',monospace;font-size:.66rem;font-weight:700;cursor:pointer;letter-spacing:.06em">ADD TO BINDER</button>';
        html += '<button onclick="_applyProductScanToListing()" style="flex:2 1 140px;padding:10px;border:1px solid var(--copper-dim);background:transparent;color:var(--copper);font-family:\'Space Mono\',monospace;font-size:.66rem;cursor:pointer;letter-spacing:.06em">LIST FOR SALE</button>';
        html += '</div>';

        if (resultEl) resultEl.innerHTML = html;

        // Fill the sealed-candidate panel asynchronously so the user
        // gets immediate feedback from the extraction step, and the
        // tappable candidates light up as soon as the catalog query
        // returns. Three outcomes:
        //   (a) candidates found → render tappable rows with two
        //       buttons each: ADD TO BINDER + LIST FOR SALE (or
        //       RECORD SALE if POS mode is on)
        //   (b) no catalog match → show "No catalog match" hint
        //   (c) extractor returned nothing → panel stays hidden
        if (ptype === 'sealed') {
          try {
            const candidates = await _sealedCandidatesP;
            window._lastProductScan.candidates = candidates;
            const panel = document.getElementById('sealedCandidates');
            if (!panel) return;
            if (!candidates.length) {
              // No catalog match — give the user a way to add to
              // inventory manually using the extracted fields as a
              // pre-fill. Vendors stocking new releases shouldn't be
              // forced into the marketplace listing form just because
              // the sealed sync hasn't ingested the set yet.
              panel.innerHTML = '<div style="font-size:.55rem;letter-spacing:.1em;color:var(--accent);margin-bottom:6px">CATALOG MATCHES</div>'
                + '<div style="font-size:.7rem;color:var(--muted);padding:8px 0;line-height:1.5">'
                +   'No matching sealed products in catalog yet. You can still:'
                + '</div>'
                + '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px">'
                +   '<button onclick="_confirmSealedManualAdd()" style="padding:10px;border:1px solid var(--accent);background:var(--accent);color:var(--text-on-accent);font-family:\'Space Mono\',monospace;font-size:.7rem;font-weight:700;cursor:pointer;letter-spacing:.06em">ADD TO BINDER (MANUAL)</button>'
                +   '<button onclick="_applyProductScanToListing()" style="padding:10px;border:1px solid var(--copper-dim);background:transparent;color:var(--copper);font-family:\'Space Mono\',monospace;font-size:.7rem;cursor:pointer;letter-spacing:.06em">DONE → LIST FOR SALE</button>'
                + '</div>'
                + '<div style="font-size:.6rem;color:var(--muted);margin-top:4px;font-style:italic">'
                +   'ADD TO BINDER skips the catalog and creates the row from the OCR fields directly. You can edit it later.'
                + '</div>';
              return;
            }
            const isPos = !!window._posSaleMode;
            const rowsHtml = candidates.map(function(c, i) {
              var img = c.image_url
                ? '<img src="' + _escHtml(c.image_url) + '" alt="" loading="lazy" style="width:36px;height:50px;object-fit:cover;background:var(--surface2);border:1px solid var(--border)">'
                : '<div style="width:36px;height:50px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--copper-dim);font-size:.6rem">?</div>';
              var actions = isPos
                ? '<button onclick="_confirmSealedSale(' + i + ')" style="padding:6px 10px;border:1px solid var(--copper);background:var(--copper);color:var(--surface);font-family:\'Space Mono\',monospace;font-size:.62rem;font-weight:700;cursor:pointer;letter-spacing:.06em">RECORD SALE</button>'
                : '<button onclick="_confirmSealedAdd(' + i + ')" style="padding:6px 10px;border:1px solid var(--accent);background:var(--accent);color:var(--text-on-accent);font-family:\'Space Mono\',monospace;font-size:.62rem;font-weight:700;cursor:pointer;letter-spacing:.06em">ADD TO BINDER</button>'
                  + '<button onclick="_confirmSealedList(' + i + ')" style="padding:6px 10px;border:1px solid var(--copper-dim);background:transparent;color:var(--copper);font-family:\'Space Mono\',monospace;font-size:.62rem;cursor:pointer;letter-spacing:.06em">LIST</button>';
              return '<div style="display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border);background:var(--surface2);margin-bottom:6px">'
                +   img
                +   '<div style="flex:1;min-width:0">'
                +     '<div style="font-size:.72rem;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(c.name) + '</div>'
                +     '<div style="font-size:.6rem;color:var(--muted);margin-top:2px">' + _escHtml(c.set_name || '') + (c._productType ? ' · ' + _escHtml(c._productType.replace(/_/g,' ')) : '') + '</div>'
                +   '</div>'
                +   '<div style="display:flex;gap:4px;flex-shrink:0">' + actions + '</div>'
                + '</div>';
            }).join('');
            panel.innerHTML = '<div style="font-size:.55rem;letter-spacing:.1em;color:var(--accent);margin-bottom:6px">CATALOG MATCHES — TAP TO ' + (isPos ? 'SELL' : 'ADD') + '</div>' + rowsHtml;
          } catch (e) {
            console.warn('[sealed render] failed:', e);
          }
        }
      };
      reader.readAsDataURL(file);
    };

    // Dispatch helpers for the catalog-matched sealed candidates.
    // ADD TO BINDER routes through the existing quickAddScannedCard
    // path, which already handles the vendor on_shelf_qty default,
    // schema fallback, and variant handling. RECORD SALE in POS
    // routes through _posSaleFromMatch like cards do.
    window._confirmSealedAdd = async function(idx) {
      var stash = window._lastProductScan || {};
      var pick  = (stash.candidates || [])[idx];
      if (!pick) return;
      var sc = document.getElementById('productScannerModal');
      if (sc) sc.remove();
      // quickAddScannedCard expects a row in the shape catalog returns.
      try { await quickAddScannedCard(pick); } catch (e) {
        console.error('[sealed add] failed:', e);
        showToast('Could not add: ' + (e.message || 'unknown'));
      }
    };
    window._confirmSealedSale = function(idx) {
      var stash = window._lastProductScan || {};
      var pick  = (stash.candidates || [])[idx];
      if (!pick) return;
      var sc = document.getElementById('productScannerModal');
      if (sc) sc.remove();
      _posSaleFromMatch(pick.id, pick.name);
    };
    // Bottom-row ADD TO BINDER. Used when the user wants to stock a
    // product regardless of whether the catalog had a matching row.
    // If a catalog match was selected via the per-row ADD button, it
    // routes through quickAddScannedCard. If no match exists, it
    // synthesizes a minimal "manual" product row and inserts a
    // collection_items entry with NULL api_card_id — the shop's
    // stock count is right immediately; admin can link it to a
    // catalog row later when one is synced.
    window._addProductToBinder = async function() {
      var stash = window._lastProductScan || {};
      var ex    = stash.extracted || {};
      var ptype = stash.ptype || 'other';
      // If we have a real catalog match in the candidate list, prefer
      // it — same flow as the per-row button.
      var pick = (stash.candidates || [])[0];
      var sc = document.getElementById('productScannerModal');
      if (sc) sc.remove();
      if (pick && pick.id) {
        try { await quickAddScannedCard(pick); } catch (e) {
          console.error('[add to binder] catalog-match path failed:', e);
          showToast('Could not add: ' + (e.message || 'unknown'));
        }
        return;
      }
      // Synthesize a manual product row from extracted text. Falls
      // back to "Unidentified product" if nothing meaningful was
      // extracted (the shop can rename it in the binder).
      var name = ex.set_name
        || ex.title
        || ex.character
        || (ptype !== 'other' ? ptype.replace(/_/g,' ').replace(/\b\w/g, function(s){return s.toUpperCase();}) : 'Unidentified product');
      var synthetic = {
        id:           null, // no api_card_id — manual entry
        name:         name,
        set_name:     ex.set_name || ex.series || '',
        set_code:     '',
        card_number:  '',
        rarity:       null,
        image_url:    '', // file blob isn't auto-uploaded for manual rows yet
        product_type: ptype === 'sealed' ? (ex.product_subtype || 'sealed_other') : ptype,
      };
      try {
        await quickAddScannedCard(synthetic);
        showToast('Added manually — link to catalog row from binder edit');
      } catch (e) {
        console.error('[add to binder] manual path failed:', e);
        showToast('Could not add: ' + (e.message || 'unknown'));
      }
    };

    window._confirmSealedList = function(idx) {
      var stash = window._lastProductScan || {};
      var pick  = (stash.candidates || [])[idx];
      if (!pick) return;
      // Re-stash with the picked catalog row so _applyProductScanToListing
      // can prefill the listing form with the right name + image.
      stash.extracted = Object.assign({}, stash.extracted, {
        picked_id:   pick.id,
        picked_name: pick.name,
        picked_set:  pick.set_name,
      });
      window._lastProductScan = stash;
      _applyProductScanToListing();
    };
    // Manual add to binder when no catalog match was found. Creates a
    // collection_items row with api_card_id = null (no catalog
    // reference yet) using the extracted set name + game type +
    // packaging format. The vendor can edit the card_name later if
    // they want; the priority is getting the unit into inventory so
    // POS can ring it up and the bulk-import CSV can find it.
    window._confirmSealedManualAdd = async function() {
      try {
        if (!currentUser) { showToast('Sign in to add to your binder'); return; }
        var stash = window._lastProductScan || {};
        var ex    = stash.extracted || {};
        if (!ex.set_name) { showToast('Need a set name to add manually'); return; }
        // Compose a human-readable card_name from the extracted bits.
        var fmtPretty = (ex.product_subtype || 'sealed')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, function(s) { return s.toUpperCase(); });
        var gamePretty = ({
          pokemon: 'Pokemon', mtg: 'Magic', yugioh: 'Yu-Gi-Oh',
          onepiece: 'One Piece', gundam: 'Gundam', dbz: 'Dragon Ball',
        })[ex.game_type || ''] || '';
        var cardName = [gamePretty, ex.set_name, fmtPretty].filter(Boolean).join(' ');
        var isVendor = (typeof tierAtLeast === 'function') && tierAtLeast('vendor');
        var qty = Math.max(1, Math.min(99, Number(window._scanAddQty) || 1));
        window._scanAddQty = 1;
        var _insertBase = {
          user_id:        currentUser.id,
          api_card_id:    null,
          card_name:      cardName,
          set_name:       ex.set_name,
          set_code:       null,
          card_number:    null,
          card_image_url: null,
          game_type:      ex.game_type || 'pokemon',
          product_type:   ex.product_subtype || 'sealed',
          condition:      'sealed',
          quantity:       qty,
          on_shelf_qty:   isVendor ? qty : undefined,
          variant:        'normal',
          binder_id:      (typeof currentBinderId !== 'undefined' ? currentBinderId : null),
          notes:          'Added via product scanner (no catalog match)',
        };
        // Same schema-fallback cascade as quickAddScannedCard — older
        // DBs may not have on_shelf_qty / product_type yet.
        var { data: newRow, error } = await sb.from('collection_items').insert(_insertBase).select('id').single();
        if (error) {
          var msg = String((error.message || '') + (error.details || '')).toLowerCase();
          if (msg.indexOf('on_shelf_qty') >= 0) {
            var { on_shelf_qty: _osq, ..._noShelf } = _insertBase;
            var r1 = await sb.from('collection_items').insert(_noShelf).select('id').single();
            error = r1.error; newRow = r1.data;
          }
          if (error && /product_type/i.test(error.message || '')) {
            var { product_type: _pt, ..._noPt } = _insertBase;
            var r2 = await sb.from('collection_items').insert(_noPt).select('id').single();
            error = r2.error; newRow = r2.data;
          }
        }
        if (error) { showToast('Add failed: ' + (error.message || 'unknown')); return; }
        var sc = document.getElementById('productScannerModal');
        if (sc) sc.remove();
        try { if (typeof loadCollection === 'function') await loadCollection(); } catch(_) {}
        try { if (typeof renderBinder === 'function') renderBinder(); } catch(_) {}
        showToast('Added: ' + cardName);
      } catch (e) {
        console.error('[sealed manual add] failed:', e);
        showToast('Add failed: ' + (e.message || 'unknown'));
      }
    };

    // Bridge between the product scanner and the marketplace listing
    // form. Builds a human-readable title from the extracted fields and
    // calls openListCardModal with a prefill payload. Falls back to a
    // plain close when there's nothing useful to carry forward.
    window._applyProductScanToListing = function() {
      var stash = window._lastProductScan || {};
      var ex = stash.extracted || {};
      var rawText = stash.raw || '';
      var ptype = stash.ptype || 'funko_pop';
      // Close the scanner first so the listing modal sits on top cleanly.
      var sc = document.getElementById('productScannerModal');
      if (sc) sc.remove();

      // Title + description + listing-form gameType are built per
      // detected product type. Each branch follows the same pattern:
      //   - title: human-readable headline for the listing
      //   - description: structured field summary (no raw OCR — kept
      //     clean per earlier feedback)
      //   - gameType: matches an option in the product-mode dropdown
      //   - productType: drives the listing modal's product-mode logic
      var title = '';
      var description = '';
      var gameType = 'Other';
      var productType = 'funko_pop';

      if (ptype === 'funko_pop') {
        var parts = [];
        if (ex.character) parts.push(ex.character);
        if (ex.series)    parts.push('(' + ex.series + ')');
        var base = parts.join(' ').trim();
        var suffix = ['Funko Pop!'];
        if (ex.pop_number) suffix.push(ex.pop_number);
        title = [base, suffix.join(' ').trim()].filter(Boolean).join(' - ');
        if (ex.is_chase)   title += ' [CHASE]';
        if (ex.exclusive)  title += ' [' + ex.exclusive + ']';
        description = 'Funko Pop figure.';
        if (ex.character)  description += '\nCharacter: ' + ex.character;
        if (ex.series)     description += '\nSeries: ' + ex.series;
        if (ex.pop_number) description += '\nPop #: ' + ex.pop_number;
        if (ex.exclusive)  description += '\nExclusivity: ' + ex.exclusive;
        if (ex.is_chase)   description += '\nChase variant: yes';
        gameType = 'Funko Pop';
        productType = 'funko_pop';
      } else if (ptype === 'manga') {
        var mTitle = ex.title || '';
        if (ex.volume) mTitle += (mTitle ? ', ' : '') + 'Vol. ' + ex.volume;
        title = mTitle;
        description = 'Manga.';
        if (ex.title)     description += '\nTitle: ' + ex.title;
        if (ex.volume)    description += '\nVolume: ' + ex.volume;
        if (ex.publisher) description += '\nPublisher: ' + ex.publisher;
        gameType = 'Manga';
        productType = 'manga';
      } else if (ptype === 'poster') {
        title = ex.title || '';
        if (ex.edition_number && ex.edition_total) {
          title += ' (' + ex.edition_number + '/' + ex.edition_total + ')';
        } else if (ex.limited) {
          title += ' [Limited Edition]';
        }
        if (ex.signed) title += ' [SIGNED]';
        description = (ex.publisher ? ex.publisher + ' ' : '') + 'poster / art print.';
        if (ex.title)          description += '\nTitle: ' + ex.title;
        if (ex.publisher)      description += '\nPublisher: ' + ex.publisher;
        if (ex.edition_number) description += '\nEdition: ' + ex.edition_number + ' of ' + ex.edition_total;
        if (ex.limited)        description += '\nLimited Edition: yes';
        if (ex.signed)         description += '\nSigned: yes';
        gameType = 'Posters';
        productType = 'poster';
      } else if (ptype === 'plush') {
        var plushParts = [];
        if (ex.character) plushParts.push(ex.character);
        if (ex.brand)     plushParts.push(ex.brand);
        title = plushParts.join(' - ');
        if (ex.size) title += ' (' + ex.size + ')';
        description = 'Plush.';
        if (ex.character) description += '\nName: ' + ex.character;
        if (ex.brand)     description += '\nBrand: ' + ex.brand;
        if (ex.size)      description += '\nSize: ' + ex.size;
        gameType = 'Plush';
        productType = 'plush';
      } else if (ptype === 'statue') {
        var statueParts = [];
        if (ex.character) statueParts.push(ex.character);
        if (ex.series)    statueParts.push('(' + ex.series + ')');
        title = statueParts.join(' ').trim();
        var statueSuffix = [];
        if (ex.brand) statueSuffix.push(ex.brand);
        if (ex.scale) statueSuffix.push(ex.scale + ' Scale');
        if (statueSuffix.length) title += ' - ' + statueSuffix.join(' ');
        description = 'Statue / collectible figure.';
        if (ex.character) description += '\nCharacter: ' + ex.character;
        if (ex.series)    description += '\nSeries: ' + ex.series;
        if (ex.brand)     description += '\nBrand: ' + ex.brand;
        if (ex.scale)     description += '\nScale: ' + ex.scale;
        gameType = 'Statues';
        productType = 'statue';
      } else {
        // 'other' — no structured fields. Open the modal with a blank
        // title so the shop can fill in manually. The scan photo still
        // carries over via the lcPhotos push below.
        title = '';
        description = '';
        gameType = 'Other';
        productType = 'funko_pop'; // still product-mode so condition is hidden
      }

      if (typeof openListCardModal !== 'function') {
        showToast('Listing modal unavailable — try again.');
        return;
      }
      openListCardModal({
        cardName: title || '',
        gameType: gameType,
        productType: productType
      });
      // openListCardModal resets lcDescription = '' and lcPhotos = [];
      // populate both AFTER it runs so the scan photo + description land
      // in the form. The setTimeout(50) puts us safely after the reset.
      setTimeout(function() {
        var descEl = document.getElementById('lcDescription');
        if (descEl) descEl.value = description;
        // Carry the scanned image over as the listing's first photo so
        // the shop doesn't have to retake. lcPhotos is an array of File
        // objects; renderLcPhotoPreview builds thumbs via createObjectURL.
        if (stash.file && typeof lcPhotos !== 'undefined') {
          try {
            lcPhotos.push(stash.file);
            if (typeof renderLcPhotoPreview === 'function') renderLcPhotoPreview();
          } catch (_) { /* if anything is undefined, fall through silently */ }
        }
      }, 50);
    };

    window.PRODUCT_CATEGORIES = {
      tcg_single: {
        display:     'TCG Singles',
        photoAspect: '245:342',
        scannerType: 'tcg',
        fields: [
          // TCG schema lives in collection_items + catalog already.
          // Listing flow uses existing add-card UI, not this fields list.
        ],
      },
      tcg_sealed: {
        display:     'TCG Sealed',
        photoAspect: '1:1',
        scannerType: 'tcg',
        fields: [],
      },
      funko_pop: {
        display:     'Funko Pop',
        photoAspect: '4:5',
        scannerType: 'funko',
        fields: [
          { key: 'character',   label: 'Character',   type: 'text',   placeholder: 'e.g. Pikachu' },
          { key: 'series',      label: 'Series / Line', type: 'text', placeholder: 'e.g. Pokemon, Marvel, Disney' },
          { key: 'pop_number',  label: 'Pop #',       type: 'text',   placeholder: 'e.g. #353' },
          { key: 'exclusive',   label: 'Exclusivity', type: 'text',   placeholder: 'e.g. Hot Topic Exclusive (or leave blank)' },
          { key: 'condition',   label: 'Box Condition', type: 'select', options: ['Mint','Near Mint','Very Good','Damaged','Loose (no box)'] },
          { key: 'is_chase',    label: 'Chase variant?', type: 'checkbox' },
          { key: 'is_grail',    label: 'Vaulted / Grail?', type: 'checkbox' },
          { key: 'year',        label: 'Release Year', type: 'text',   placeholder: 'e.g. 2018' },
        ],
      },
    };

    function showScanResults(matches) {
      window._scanMatches = matches;
      const wrap = document.getElementById('scannerResults');
      const slab = window._detectedSlab;

      // ── Slab banner ──────────────────────────────────────────────────────
      const companyLabels = { psa:'PSA', bgs:'BGS / Beckett', cgc:'CGC', sgc:'SGC', ace:'ACE' };
      const slabBanner = slab ? `
        <div style="background:rgba(26,199,160,.08);border:1px solid rgba(26,199,160,.4);padding:10px 12px;margin-bottom:12px;font-family:'Space Mono','Share Tech Mono',monospace">
          <div style="font-size:.58rem;color:var(--teal);letter-spacing:.1em;margin-bottom:5px">◈ GRADED SLAB DETECTED</div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:.7rem">
            <span style="color:var(--text);font-weight:700">${companyLabels[slab.company] || slab.company.toUpperCase()}</span>
            ${slab.grade    ? `<span style="color:var(--accent)">Grade: <strong>${slab.grade}</strong></span>` : ''}
            ${slab.certNumber ? `<span style="color:var(--muted)">Cert #${slab.certNumber}</span>` : ''}
          </div>
          <div style="font-size:.62rem;color:var(--muted);margin-top:6px">Cert info will auto-fill when you select a match below.</div>
        </div>` : '';

      wrap.innerHTML = slabBanner +
        `<div style="font-family:'Space Mono','Share Tech Mono',monospace;font-size:.6rem;color:var(--accent2);letter-spacing:.06em;margin-bottom:10px">${matches.length} POSSIBLE MATCHES — tap to inspect</div>` +
        matches.map((m, idx) => {
          const pct = Math.round(m.similarity * 100);
          const bar = `<div style="height:3px;background:var(--border);margin-top:4px"><div style="height:100%;width:${pct}%;background:${pct > 80 ? 'var(--accent)' : pct > 65 ? 'var(--accent2)' : 'var(--muted)'}"></div></div>`;
          const setInfo = [m.set_name, m.card_number ? `#${m.card_number}` : '', m.rarity].filter(Boolean).join(' · ');
          const sourceBadge = m._exact
            ? `<span style="background:var(--accent);color:var(--text-on-accent);font-size:.5rem;padding:1px 5px;border-radius:2px;font-weight:700;margin-left:6px;vertical-align:middle">EXACT</span>`
            : m._ocr
              ? `<span style="background:var(--copper);color:#1a0a00;font-size:.5rem;padding:1px 5px;border-radius:2px;font-weight:700;margin-left:6px;vertical-align:middle">OCR</span>`
              : `<span style="color:var(--muted);font-size:.55rem;margin-left:6px">${pct}%</span>`;
          const jpBadge = m.id && m.id.startsWith('jp-')
            ? `<span style="font-size:.85em;margin-left:4px" title="Japanese card">[JP]</span>` : '';
          return `
            <div class="scan-match-card" onclick="previewScanMatch(${idx})">
              <img class="scan-match-thumb" src="${m.image_url || ''}" alt="${m.name}" onerror="this.style.display='none'" loading="lazy" decoding="async">
              <div class="scan-match-info">
                <div class="scan-match-name">${m.name || 'Unknown Card'}${jpBadge}${sourceBadge}</div>
                ${setInfo ? `<div style="font-family:'Space Mono','Share Tech Mono',monospace;font-size:.58rem;color:var(--muted);margin-bottom:2px">${setInfo}</div>` : ''}
                ${!m._ocr && !m._exact ? `<div class="scan-match-sim">${bar}</div>` : ''}
              </div>
              <button class="scan-match-add" onclick="event.stopPropagation();previewScanMatch(${idx})">VIEW ›</button>
            </div>`;
        }).join('');
    }

    let _returnToScanner = false;

    // Quantity adjuster for the scan preview sheet. The "+ ADD" flow
    // reads window._scanAddQty when building the insert, so this
    // helper just mutates that + repaints the visible number. Capped
    // 1-99 to match the collection_items quantity input range.
    window._scanQtyAdjust = function(delta) {
      var cur = window._scanAddQty || 1;
      var next = Math.max(1, Math.min(99, cur + delta));
      window._scanAddQty = next;
      var el = document.getElementById('scanQtyVal');
      if (el) el.textContent = String(next);
    };

    // Show a card detail sheet so the user can inspect before confirming
    function previewScanMatch(idx) {
      const m = (window._scanMatches || [])[idx];
      if (!m) return;
      document.getElementById('scanPreviewSheet')?.remove();
      // Reset stepper to 1 on each preview open — last scan's qty
      // shouldn't carry over to the next card.
      window._scanAddQty = 1;

      const setInfo = [m.set_name, m.card_number ? `#${m.card_number}` : '', m.rarity].filter(Boolean).join(' · ');
      const jpBadge = m.id && (m.id.startsWith('jp-') || m.id.startsWith('pd-'))
        ? `<span style="font-size:.75rem;color:var(--copper);margin-left:6px">[JP]</span>` : '';

      const sheet = document.createElement('div');
      sheet.id = 'scanPreviewSheet';
      // Center the preview sheet on screen. Earlier code anchored it
       // to the bottom with align-items:flex-end (legacy bottom-sheet
       // pattern); switching to center makes the modal look correct
       // on desktop too.
      sheet.style.cssText = 'position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;padding:20px';
      sheet.innerHTML = `
        <div onclick="document.getElementById('scanPreviewSheet').remove()" style="position:absolute;inset:0;background:rgba(0,0,0,.55)"></div>
        <div style="position:relative;width:100%;max-width:480px;background:var(--surface);border:2px solid var(--copper-dim);border-radius:6px;padding:20px 18px 28px;max-height:85svh;overflow-y:auto;box-shadow:0 0 30px var(--copper-glow)">
          <!-- close -->
          <button onclick="document.getElementById('scanPreviewSheet').remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--muted)">×</button>
          <!-- label -->
          <div style="font-size:.52rem;letter-spacing:.14em;color:var(--copper);margin-bottom:14px">◈ CARD DETAIL</div>
          <!-- image — onerror handler swaps in a clean NO-IMAGE block.
               (The previous version had its loading="lazy" attribute
               mangled INTO the escaped HTML string, which leaked a
               "NO IMAGE" pill next to a successfully-loaded image.) -->
          ${m.image_url ? `<div style="display:flex;justify-content:center;margin-bottom:14px">
            <img src="${m.image_url}" alt="${m.name || ''}" loading="lazy" decoding="async"
              style="max-width:180px;width:100%;height:auto;border:1px solid var(--copper-dim);border-radius:4px;box-shadow:0 0 20px var(--copper-glow);cursor:zoom-in"
              onclick="openImageLightbox('${m.image_url}')"
              onerror="this.parentElement.innerHTML='<div style=&quot;width:180px;height:252px;background:rgba(184,115,51,.06);border:1px solid var(--copper-dim);border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px&quot;><span style=&quot;font-size:2rem;opacity:.25&quot;>⬡</span><span style=&quot;font-size:.55rem;letter-spacing:.1em;color:var(--copper-dim)&quot;>NO IMAGE</span></div>'">
          </div>` : ''}
          <!-- info -->
          <div style="text-align:center;margin-bottom:16px">
            <div style="font-size:.95rem;font-weight:700;color:var(--text);margin-bottom:4px">${m.name || 'Unknown Card'}${jpBadge}</div>
            ${setInfo ? `<div style="font-size:.63rem;color:var(--muted)">${setInfo}</div>` : ''}
          </div>
          <!-- actions — flex with two modes:
               * Normal scan: qty stepper + ADD TO COLLECTION + WISHLIST.
                 Stepper mutates window._scanAddQty; quickAddScannedCard
                 reads that into _insertBase.quantity. Saves opening the
                 binder card detail to increment after every duplicate.
               * POS scan mode (_posSaleMode): collapsed to a single
                 RECORD SALE button — the action routes to the Mark N
                 Sold modal via confirmScanMatch's POS short-circuit.
                 Wishlist + qty are hidden because they don't apply when
                 the vendor is ringing up a sale (sale qty lives in the
                 Mark N Sold modal itself). -->
          <div style="display:flex;flex-direction:column;gap:8px">
            ${window._posSaleMode ? `
              <button onclick="document.getElementById('scanPreviewSheet').remove();confirmScanMatch('${m.id}','${(m.name||'').replace(/'/g,"\\'")}')"
                style="width:100%;padding:14px;background:var(--copper);color:var(--surface);border:1px solid var(--copper);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.82rem;font-weight:700;cursor:pointer;letter-spacing:.08em;transition:opacity .12s;box-shadow:0 0 18px var(--copper-glow)"
                onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                RECORD SALE
              </button>
            ` : `
              <div style="display:flex;gap:8px;align-items:stretch">
                <div style="display:flex;align-items:center;border:1px solid var(--accent);border-radius:4px;background:var(--surface2,var(--surface));overflow:hidden;font-family:'Space Mono','Share Tech Mono',monospace">
                  <button type="button" onclick="_scanQtyAdjust(-1)"
                    style="padding:0 12px;height:100%;border:none;background:transparent;color:var(--accent);font-size:1rem;font-weight:700;cursor:pointer;line-height:1"
                    aria-label="Decrease quantity">−</button>
                  <span id="scanQtyVal"
                    style="min-width:28px;text-align:center;color:var(--text);font-size:.85rem;font-weight:700;padding:0 4px;user-select:none">1</span>
                  <button type="button" onclick="_scanQtyAdjust(1)"
                    style="padding:0 12px;height:100%;border:none;background:transparent;color:var(--accent);font-size:1rem;font-weight:700;cursor:pointer;line-height:1"
                    aria-label="Increase quantity">+</button>
                </div>
                <button onclick="document.getElementById('scanPreviewSheet').remove();confirmScanMatch('${m.id}','${(m.name||'').replace(/'/g,"\\'")}')"
                  style="flex:1;padding:11px;background:var(--accent);color:var(--text-on-accent);border:none;font-family:'Space Mono','Share Tech Mono',monospace;font-size:.74rem;font-weight:700;cursor:pointer;letter-spacing:.06em;transition:opacity .12s"
                  onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
                  ADD TO COLLECTION
                </button>
              </div>
              <button onclick="document.getElementById('scanPreviewSheet').remove();openAddToWishlistModal({cardName:'${(m.name||'').replace(/'/g,"\\'")}',setName:'${(m.set_name||'').replace(/'/g,"\\'")}',cardNumber:'${m.card_number||''}',cardImageUrl:'${m.image_url||''}',rarity:'${m.rarity||''}'})"
                style="width:100%;padding:9px;border:1px solid var(--copper-dim);background:transparent;color:var(--copper);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.7rem;cursor:pointer;letter-spacing:.06em;transition:all .15s"
                onmouseover="this.style.borderColor='var(--copper)';this.style.background='var(--copper-glow)'" onmouseout="this.style.borderColor='var(--copper-dim)';this.style.background='transparent'">
                ADD TO WISHLIST
              </button>
            `}
            <button onclick="document.getElementById('scanPreviewSheet').remove()"
              style="width:100%;padding:8px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.66rem;cursor:pointer">
              BACK TO RESULTS
            </button>
          </div>
        </div>`;
      document.body.appendChild(sheet);
    }

    // Quick-save a scanned card straight to the user's binder with
    // sensible defaults. Skips the legacy add-to-binder modal entirely
    // — the user edits photo / condition / price from the binder card
    // detail instead. This sidesteps the iOS Safari + Brave bug where
    // the bg-removal AI model loading caused the tab to reload and
    // wipe out the in-flight modal state.
    //
    // Defaults: raw (or detected slab grade), qty 1, current binder,
    // catalog image as the card photo. Slab data is auto-applied
    // when window._detectedSlab is set.
    // Quick chip-style variant picker used by the scanner save path.
    // Returns 'normal' | 'reverse_holo' | null (cancelled). Renders
    // a lightweight overlay rather than a full modal because the
    // scanner is already in modal-stack territory and a nested
    // openModal/closeModal call fights the scanner's overlay state.
    // baseFinish: 'normal' (default — non-holo card with RH variant)
    //          or 'holo' (Rare Holo / Rare Holo EX / etc — base print is
    //             already holo, RH is a SEPARATE foil pattern). Picker
    //             labels and the returned value flex accordingly so a
    //             holo Gengar saves as variant='holo', not 'normal'.
    // z-index is 100030 so the picker sits ABOVE the scan results sheet
    // (100010) and the scanner camera (100020). Old value of 30001 left
    // the picker invisible behind the results sheet.
    function _promptVariantChoice(cardName, baseFinish) {
      baseFinish = (baseFinish === 'holo') ? 'holo' : 'normal';
      const baseLabel = baseFinish === 'holo' ? 'Holo' : 'Normal';
      return new Promise(function(resolve) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100030;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:18px';
        overlay.innerHTML =
          '<div style="background:var(--surface);border:1px solid var(--accent);box-shadow:0 0 32px rgba(26,199,160,.25);padding:22px 24px;max-width:360px;width:100%;font-family:\'Space Mono\',\'Share Tech Mono\',monospace;border-radius:var(--r-lg,12px)">'
        +   '<div style="font-size:.6rem;letter-spacing:.12em;color:var(--accent);margin-bottom:6px">◈ WHICH FINISH?</div>'
        +   '<div style="font-size:.85rem;color:var(--text);margin-bottom:14px;line-height:1.4">' + _escHtml(cardName) + '</div>'
        +   '<div style="font-size:.7rem;color:var(--muted);margin-bottom:14px;line-height:1.5">This card has a Reverse Holo printing. Which one did you scan?</div>'
        +   '<div style="display:flex;gap:8px;flex-wrap:wrap">'
        +     '<button data-pick="' + baseFinish + '"  style="flex:1;padding:10px 14px;border:1px solid var(--accent);background:var(--accent);color:var(--text-on-accent);font-family:inherit;font-size:.72rem;font-weight:700;letter-spacing:.06em;cursor:pointer;border-radius:var(--r-sm,6px)">' + baseLabel + '</button>'
        +     '<button data-pick="reverse_holo" style="flex:1;padding:10px 14px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-family:inherit;font-size:.72rem;font-weight:700;letter-spacing:.06em;cursor:pointer;border-radius:var(--r-sm,6px)">Reverse Holo</button>'
        +   '</div>'
        +   '<button data-pick="cancel" style="margin-top:12px;width:100%;padding:8px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:inherit;font-size:.68rem;letter-spacing:.06em;cursor:pointer;border-radius:var(--r-sm,6px)">Cancel</button>'
        + '</div>';
        document.body.appendChild(overlay);
        const cleanup = function(val) {
          try { overlay.remove(); } catch(_) {}
          resolve(val);
        };
        overlay.addEventListener('click', function(e) {
          const btn = e.target.closest('[data-pick]');
          if (!btn) {
            // Click outside the inner panel = cancel
            if (e.target === overlay) cleanup(null);
            return;
          }
          const p = btn.getAttribute('data-pick');
          cleanup(p === 'cancel' ? null : p);
        });
      });
    }

    async function quickAddScannedCard(card) {
      if (!currentUser) { showToast('Sign in to add cards to your collection'); return; }
      if (!canAddMoreCards()) {
        showToast('Free plan limit: 200 cards reached');
        if (typeof openPricingModal === 'function') openPricingModal('collector');
        return;
      }

      const isJpCard = card.id && String(card.id).startsWith('jp-');
      const language = isJpCard ? 'JA' : 'EN';

      // Apply slab data if scanner detected a graded card
      const slab = window._detectedSlab;
      let condition = 'raw';
      let gradeValue = null;
      let certNumber = null;
      if (slab) {
        const validConds = ['psa', 'bgs', 'cgc', 'sgc', 'ace', 'tag'];
        if (validConds.includes(slab.company)) condition = slab.company;
        const validGrades = ['10','9.5','9','8.5','8','7.5','7','6.5','6','5.5','5','4.5','4','3','2','1'];
        if (slab.grade && validGrades.includes(slab.grade)) gradeValue = parseFloat(slab.grade);
        if (slab.certNumber) certNumber = slab.certNumber;
      }

      // Scanner-driven variant prompt. If the catalog row signals an
      // RH variant exists, give the user a quick chip-style picker
      // BEFORE the silent insert — otherwise a scan auto-saves as
      // Normal and they'd have to manually flip it later. Cancel from
      // the prompt aborts the add (the user can re-scan).
      //
      // Default base finish is 'normal'. If the catalog row's rarity
      // is "Rare Holo" / "Rare Holo EX" / "Rare Holo V" / etc, the
      // base printing is already holo and the picker should offer
      // Holo vs Reverse Holo (not Normal). Excludes "Reverse Holo"
      // rarity (the row IS the RH printing) and "Rare Secret" (which
      // sometimes contains holo descriptors but is its own variant
      // tier we don't disambiguate at scan time).
      const _rar = String(card.rarity || '');
      const _baseFinish = (/\bholo\b/i.test(_rar) && !/reverse/i.test(_rar) && !/secret/i.test(_rar))
        ? 'holo'
        : 'normal';
      let scanVariant = _baseFinish;
      if (card.has_reverse_holo) {
        const pick = await _promptVariantChoice(card.name || 'this card', _baseFinish);
        if (pick === null) { showToast('Add cancelled'); return; }
        scanVariant = pick;
      }

      // User-set quantity from the preview-sheet stepper. Defaults to
      // 1 if the stepper wasn't shown (e.g. POS quick-add path) or
      // was never touched. Cap 1-99 matches the collection_items
      // qty input. Note: for vendor+ inventory tracking, the same
      // value is used as on_shelf_qty further down via the existing
      // shop-inventory backfill in saveToCollection.
      const _scanQty = Math.max(1, Math.min(99, Number(window._scanAddQty) || 1));
      window._scanAddQty = 1; // reset so the next scan starts at 1

      // For Vendor+ tier users, default on_shelf_qty to the scanned
      // quantity. The DB column has a NOT NULL DEFAULT 0, so omitting
      // it (the previous behavior) caused every scan-added card to
      // land with 0 on-shelf even though the vendor owned it — which
      // then made POS scan refuse the sale with "Out of stock" the
      // next time the same card was scanned. The Add-to-Binder modal
      // already applied this default; the scanner just forgot to.
      const _isVendor = (typeof tierAtLeast === 'function') && tierAtLeast('vendor');
      const _insertBase = {
        user_id:          currentUser.id,
        api_card_id:      card.id || null,
        card_name:        card.name || '(unnamed)',
        set_name:         card.set_name   || null,
        set_code:         card.set_code   || null,
        card_number:      card.card_number || null,
        card_image_url:   card.image_url  || null,
        game_type:        'pokemon',
        condition,
        grade_value:      gradeValue,
        cert_number:      certNumber,
        quantity:         _scanQty,
        on_shelf_qty:     _isVendor ? _scanQty : undefined,
        purchase_price:   null,
        purchase_date:    null,
        price_source_url: null,
        notes:            null,
        binder_id:        currentBinderId || null,
        language,
        rarity:           card.rarity || null,
        variant:          scanVariant,
      };

      try { applyOverrideToInsertRow(_insertBase); } catch(_) {}

      // Insert with schema fallback (some older DBs lack language/rarity)
      let { data: newRow, error } = await sb.from('collection_items')
        .insert(_insertBase).select('id').single();
      const _isSchemaErr = (e) => {
        if (!e) return false;
        const str = (e.message || '') + (e.details || '') + (e.hint || '') + (e.code || '');
        return str.toLowerCase().includes('language') ||
               str.toLowerCase().includes('schema cache') ||
               str.toLowerCase().includes('column');
      };
      if (_isSchemaErr(error)) {
        // Strip on_shelf_qty first — it's the newest column and most
        // likely to be missing on an older DB that hasn't run the
        // shop-inventory migration. The cascade goes:
        //   1. drop on_shelf_qty
        //   2. drop language
        //   3. drop language + rarity (oldest schema)
        const { on_shelf_qty: _osq, ..._noShelf } = _insertBase;
        const r1 = await sb.from('collection_items').insert(_noShelf).select('id').single();
        if (!r1.error) { newRow = r1.data; error = null; }
        else if (_isSchemaErr(r1.error)) {
          const { language: _l, ..._noLang } = _noShelf;
          const r2 = await sb.from('collection_items').insert(_noLang).select('id').single();
          if (!r2.error) { newRow = r2.data; error = null; }
          else if (_isSchemaErr(r2.error)) {
            const { rarity: _r2, ..._bare } = _noLang;
            const r3 = await sb.from('collection_items').insert(_bare).select('id').single();
            newRow = r3.data; error = r3.error;
          } else { newRow = r2.data; error = r2.error; }
        } else { newRow = r1.data; error = r1.error; }
      }

      if (error) {
        showToast('Error saving card: ' + error.message);
        return;
      }

      // Pre-warm price cache for non-English cards in the background
      if (language !== 'EN') {
        try {
          fetchCardPriceForLanguage({
            cardName:   card.name,
            language,
            setName:    card.set_name   || undefined,
            cardNumber: card.card_number || undefined,
            apiCardId:  card.id        || undefined,
          }).catch(() => {});
        } catch(_) {}
      }

      var savedToast = card._userPhotoApplied
        ? (card.name || 'Card') + ' added with your photo'
        : (card.name || 'Card') + ' added — tap to edit photo';
      showToast(savedToast);
      _returnToScanner = false;
      pendingCollectionCard = null;
      try { window._detectedSlab = null; } catch(_) {}
      try { window._scanCapturedDataUrl = null; } catch(_) {}

      // Tear down scanner UI so we land on the binder cleanly. The
      // camera stream itself is left intact — the existing scanner
      // teardown path runs whenever the modal is re-opened or the
      // page navigates away.
      const scannerModal = document.getElementById('scannerModal');
      if (scannerModal) scannerModal.style.display = 'none';
      document.getElementById('scanPreviewSheet')?.remove();

      try { await loadCollection(); checkBadge_stacked(); checkBadge_phantom_p2(); } catch(_) {}
      try { renderCollection(); } catch(_) {}

      // Stay on the Add Card page after save — the toast confirms the
      // add and the user can scan their next card immediately. The
      // binder card detail (edit photo / condition / price) is one tap
      // away from the binder if they want it. Removed the auto-jump to
      // openBinderCardDetail per UX feedback — felt like an unwanted
      // second modal popping up mid-flow.

      return newRow;
    }

    async function confirmScanMatch(cardId, cardName) {
      // POS mode short-circuit: skip the binder-add path and route
      // to the Mark N Sold modal so the shop can ring up the sale
      // directly. Set by openPosSaleScanner(); cleared by exitPosMode().
      if (window._posSaleMode) {
        return _posSaleFromMatch(cardId, cardName);
      }
      // Fetch full card data from catalog then quick-save directly to
      // the binder. The legacy "Add to Binder" modal is bypassed so the
      // user doesn't lose progress if the page reloads under memory
      // pressure (background-removal AI model on iOS Safari/Brave).
      const { data: card } = await sb.from('catalog').select('*').eq('id', cardId).maybeSingle();
      if (!card) { showToast('Card not found in catalog'); return; }

      // Upload the user's scan photo as the binder card image. Without
      // this, collection_items.card_image_url would be set to the catalog
      // stock photo (which is the same image every user sees). Using
      // their own capture means each user's binder shows what they
      // actually own — wear, holo, signed, custom slabs etc. Falls back
      // silently to the catalog stock image if upload fails (network
      // error, storage RLS, etc.) so a hiccup doesn't block the save.
      const userPhotoUrl = await _uploadScanCaptureAsUserPhoto();
      if (userPhotoUrl) {
        card.image_url = userPhotoUrl;
        card._userPhotoApplied = true;
      }

      await quickAddScannedCard(card);
    }

    // ── POS Sale mode ───────────────────────────────────────────────
    // Reuses the existing card scanner. When _posSaleMode is true,
    // confirmScanMatch routes here instead of saving to the binder.
    // Looks up the matching collection_items row, opens the Mark N
    // Sold modal pre-filled with that row, and after submission
    // reopens the scanner for the next sale. Persists until the user
    // taps "EXIT POS" or closes the scanner.
    function openPosSaleScanner() {
      if (!currentUser) { openModal('loginModal'); return; }
      if (typeof tierAtLeast !== 'function' || !tierAtLeast('vendor')) {
        showToast('Vendor tier required for POS scan');
        return;
      }
      window._posSaleMode = true;
      _setPosBanner(true);
      openCardScanner();
      // Auto-trigger the camera so the user goes straight to capture
      // (matches the "ADD CARD" mobile UX where tapping scan opens
      // the file picker in capture mode).
      try {
        const input = document.getElementById('navScanCardInput');
        if (input) input.click();
        else openScanCard();
      } catch(_) { openScanCard(); }
    }

    function exitPosMode() {
      window._posSaleMode = false;
      _setPosBanner(false);
      closeCardScanner();
      try { if (document.getElementById('inventory')?.classList.contains('active')) renderInventory(); } catch(_) {}
    }

    // Paints / clears the POS-mode chrome on the scanner modal so the
    // user always knows what mode they're scanning in. Defensive
    // about the modal not existing — the scanner DOM is built lazily.
    function _setPosBanner(on) {
      const modal = document.getElementById('scannerModal');
      if (!modal) return;
      let banner = document.getElementById('posScannerBanner');
      if (!on) { if (banner) banner.remove(); return; }
      if (banner) return;
      banner = document.createElement('div');
      banner.id = 'posScannerBanner';
      banner.style.cssText = 'position:absolute;top:0;left:0;right:0;background:var(--copper);color:var(--surface);padding:8px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-family:"Space Mono",monospace;font-size:.72rem;font-weight:700;letter-spacing:.08em;z-index:10;box-shadow:0 0 18px var(--copper-glow)';
      banner.innerHTML = '<span>POS SALE MODE — scan a card to record sale</span>'
        + '<button onclick="exitPosMode()" style="padding:4px 10px;border:1px solid var(--surface);background:transparent;color:var(--surface);font-family:inherit;font-size:.68rem;font-weight:700;cursor:pointer;letter-spacing:.08em">EXIT POS</button>';
      modal.appendChild(banner);
    }

    async function _posSaleFromMatch(cardId, cardName) {
      if (!currentUser) return;
      // Find every collection_items row this user has for this catalog
      // id. There may be multiple — one per variant — so prefer:
      //   1) variant === 'normal' (or null) WITH on_shelf_qty > 0
      //   2) any other variant WITH on_shelf_qty > 0
      //   3) any row regardless of stock (we'll show "out of stock")
      const candidates = (collectionItems || []).filter(function(c) {
        return c.api_card_id === cardId && !c.is_ghost && !c.sold_offline;
      });
      if (candidates.length === 0) {
        showToast('Not in your inventory: ' + (cardName || 'this card'));
        return;
      }
      const _shelfOf = function(c) { return (c.on_shelf_qty != null) ? c.on_shelf_qty : (c.quantity || 0); };
      const _isNormal = function(c) { return !c.variant || c.variant === 'normal'; };

      let pick = candidates.find(function(c) { return _isNormal(c) && _shelfOf(c) > 0; });
      if (!pick) pick = candidates.find(function(c) { return _shelfOf(c) > 0; });
      if (!pick) pick = candidates[0];

      if (_shelfOf(pick) <= 0) {
        showToast('Out of stock: ' + (pick.card_name || cardName));
        return;
      }

      // Close the scanner sheet — Mark N Sold takes over. We hide the
      // scanner modal INLINE rather than calling closeCardScanner()
      // because that helper clears window._posSaleMode (so it doesn't
      // stick across normal scans) and we need the flag to survive
      // through the modal submit so the loop in submitMarkSold can
      // reopen the scanner for the next sale.
      try { document.getElementById('scanPreviewSheet')?.remove(); } catch(_) {}
      const _sm = document.getElementById('scannerModal');
      if (_sm) _sm.style.display = 'none';
      const _banner = document.getElementById('posScannerBanner');
      if (_banner) _banner.remove();
      openMarkSoldModal(pick.id);
    }

    // ── Upload the captured scan photo to card-photos storage ─────────────────
    // Reads window._scanCapturedDataUrl (set by runMatch at scan start),
    // converts the data: URL → Blob → webp via _imgToWebpBlob, uploads to
    // the same collection/<user-id>/<timestamp>.webp path the binder
    // detail uses for manual photo edits. Returns the public URL or null
    // on any failure (caller falls back to the catalog stock photo).
    async function _uploadScanCaptureAsUserPhoto() {
      try {
        if (!currentUser) return null;
        var dataUrl = window._scanCapturedDataUrl;
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;

        // dataURL → Blob (same trick the binder detail uses)
        var res  = await fetch(dataUrl);
        var blob = await res.blob();
        if (!blob || !blob.size) return null;

        // webp re-encode (smaller / faster downloads on next visit)
        var conv = await _imgToWebpBlob(blob);
        var path = 'collection/' + currentUser.id + '/' + Date.now() + '_' +
                   Math.random().toString(36).slice(2, 7) + '.' + conv.ext;
        var up = await sb.storage.from('card-photos').upload(path, conv.blob, {
          upsert: false, contentType: conv.contentType
        });
        if (up && up.error) return null;
        var publicData = sb.storage.from('card-photos').getPublicUrl(path);
        return (publicData && publicData.data && publicData.data.publicUrl) || null;
      } catch (_) {
        return null;
      }
    }

    // Search catalog by name — shown in scanner when user wants to find exact version
    let _scanSearchTimer = null;
    async function scannerNameSearch(val) {
      clearTimeout(_scanSearchTimer);
      const out = document.getElementById('scannerNameResults');
      if (!val || val.length < 2) { if (out) out.innerHTML = ''; return; }
      _scanSearchTimer = setTimeout(async () => {
        const { data } = await sb.from('catalog')
          .select('id, name, set_name, card_number, rarity, image_url')
          .ilike('name', `%${val}%`)
          .limit(12);
        if (!out) return;
        out.innerHTML = (data || []).map(m => {
          const setInfo = [m.set_name, m.card_number ? `#${m.card_number}` : '', m.rarity].filter(Boolean).join(' · ');
          return `<div class="scan-match-card" onclick="confirmScanMatch('${m.id}','${(m.name||'').replace(/'/g,"\\'")}')">
            <img class="scan-match-thumb" src="${m.image_url||''}" alt="${m.name}" onerror="this.style.display='none'" loading="lazy" decoding="async">
            <div class="scan-match-info">
              <div class="scan-match-name">${m.name}</div>
              ${setInfo ? `<div style="font-family:'Space Mono','Share Tech Mono',monospace;font-size:.58rem;color:var(--muted)">${setInfo}</div>` : ''}
            </div>
            <button class="scan-match-add">+ Add</button>
          </div>`;
        }).join('') || '<div style="padding:10px;font-size:.7rem;color:var(--muted);font-family:\'Space Mono\',monospace">No cards found</div>';
      }, 280);
    }

    // Receive a photo from the RETAKE button inside the sheet
    async function matchFromFile(input) {
      const file = input.files[0];
      if (!file) return;
      input.value = '';
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataURL = e.target.result;
        const preview = document.getElementById('uploadPreview');
        if (preview) { preview.style.display = 'block'; preview.src = dataURL; }
        document.getElementById('scannerResults').innerHTML = '';
        setScanStatus('Scanning…');
        await runMatch(dataURL);
      };
      reader.readAsDataURL(file);
    }

    // ── Google Cloud Vision OCR ──────────────────────────────────────────────
    // Calls /api/vision-ocr (Vercel serverless endpoint) which holds the
    // GCV_API_KEY server-side and proxies the request to Google. The
    // previous version hard-coded the API key in this file, which meant
    // anyone reading the page source could steal it and run unlimited
    // Vision API calls billed to our account. Now the key never leaves
    // the server — see /api/vision-ocr.js for the proxy implementation.
    // Resize a card image down to OCR-friendly dimensions before sending
    // to the Vision proxy. Vercel functions have a 4.5MB request body
    // limit; base64 inflates payloads by ~33% so any phone photo over
    // ~3.4MB on disk would 413 here. Card OCR doesn't need huge
    // resolution — Google Vision reads text cleanly at 1200px wide, and
    // JPEG quality 0.85 keeps file size under ~250KB even at that res.
    // Returns a base64 string (no data: prefix) ready to POST.
    async function _resizeForOcr(dataURL, maxDim, quality) {
      maxDim  = maxDim  || 1200;
      quality = quality || 0.85;
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          try {
            var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
            var w = Math.round(img.naturalWidth  * scale);
            var h = Math.round(img.naturalHeight * scale);
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            // Always emit JPEG — Vision reads it fine and it's ~10×
            // smaller than PNG for photographs of cards.
            var resizedUrl = canvas.toDataURL('image/jpeg', quality);
            resolve(resizedUrl.split(',')[1] || '');
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('image load failed')); };
        img.src = dataURL;
      });
    }

    // Stitches the TOP and BOTTOM of a card image into a single
    // composite, dropping most of the middle artwork. The point isn't
    // to save bytes — it's to focus GCV's text-detection budget onto
    // the two regions that actually carry textual content:
    //
    //   Top ~38%  — card name, HP, stage, "Evolves from X"
    //   Middle    — DROPPED (mostly artwork, generates OCR noise and
    //               eats budget that Vision then can't spend on the
    //               bottom of the card)
    //   Bottom ~30% — attack name, rules text, set code + card number,
    //               illustrator credit. The set code is the smallest
    //               text on the whole card, so we 2× upscale the
    //               bottom region in the composite.
    //
    // Why this works: the original failure mode was Vision running
    // out at "…for each card" mid-rules-text before it ever reached
    // the set code at y≈0.93. By removing the middle artwork (which
    // generates spurious detections like fake characters in holo
    // sparkles) AND upscaling the bottom band, we give Vision a
    // higher signal-to-noise ratio over the regions we care about.
    //
    // One OCR call total — strictly cheaper than the old full-image
    // pass, and reliably catches MEP EN 023 / OP12-108 / SVP EN 212.
    async function _stitchForOcr(dataURL, topRatio, bottomRatio, bottomUpscale) {
      topRatio      = topRatio      || 0.38;
      bottomRatio   = bottomRatio   || 0.30;
      bottomUpscale = bottomUpscale || 2;
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          try {
            var W    = img.naturalWidth;
            var H    = img.naturalHeight;
            var topH = Math.round(H * topRatio);
            var botH = Math.round(H * bottomRatio);
            var botY = H - botH;
            // 2× upscale just the bottom region.
            var botOutH = botH * bottomUpscale;
            var botOutW = W    * bottomUpscale;
            // Top stays native — width is W. Bottom gets blown up to
            // botOutW which may exceed W. We want the composite to
            // share a single width so we leave the top at W and
            // downscale the bottom width back to W on draw.
            var gap = 12;
            var outW = W;
            var outH = topH + gap + botOutH * (W / botOutW);   // scaled bot height at width W
            var botDrawH = Math.round(botOutH * (W / botOutW));
            var canvas = document.createElement('canvas');
            canvas.width  = outW;
            canvas.height = topH + gap + botDrawH;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            // Top band — drawn at native scale.
            ctx.drawImage(img, 0, 0,    W, topH,
                                0, 0,    outW, topH);
            // Bottom band — upscaled by `bottomUpscale` via the
            // intermediate canvas trick: draw the source bottom to
            // the dest with botDrawH height, but at higher resolution
            // by first rendering into an off-screen 2× canvas.
            var off = document.createElement('canvas');
            off.width  = botOutW;
            off.height = botOutH;
            var octx = off.getContext('2d');
            octx.imageSmoothingEnabled = true;
            octx.imageSmoothingQuality = 'high';
            octx.drawImage(img, 0, botY,  W, botH,
                                 0, 0,     botOutW, botOutH);
            // Now blit the upscaled bottom into the composite. The
            // intermediate upscale ensures tiny source pixels get
            // proper bilinear interpolation before being placed.
            ctx.drawImage(off, 0, 0,           botOutW, botOutH,
                               0, topH + gap,  outW,    botDrawH);
            // Cap at 1500px max dim so phone photos don't blow the
            // Vercel proxy's body limit. Most cards land well under.
            var maxDim = 1500;
            var scale  = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
            if (scale < 1) {
              var sw = Math.round(canvas.width  * scale);
              var sh = Math.round(canvas.height * scale);
              var c2 = document.createElement('canvas');
              c2.width = sw; c2.height = sh;
              c2.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
              canvas = c2;
            }
            resolve(canvas.toDataURL('image/jpeg', 0.9));
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('image load failed')); };
        img.src = dataURL;
      });
    }

    async function ocrCardText(dataURL) {
      try {
        // Resize FIRST so phone photos don't blow the Vercel 4.5MB body
        // limit. Falls back to the raw payload if the resize fails for
        // any reason — better to attempt the upload than to silently
        // drop the OCR.
        let base64;
        try {
          base64 = await _resizeForOcr(dataURL);
        } catch (e) {
          console.warn('[GCV] resize failed, sending raw:', e);
          base64 = dataURL.indexOf(',') >= 0 ? dataURL.split(',')[1] : dataURL;
        }
        if (!base64) {
          console.warn('[GCV] empty image data');
          return '';
        }
        const res = await fetch('/api/vision-ocr', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 }),
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          const reason = (errJson && errJson.error) || ('HTTP ' + res.status);
          if (res.status === 502 || res.status === 503) {
            // Upstream (Google) issue surfaced through the proxy.
            console.error('[GCV] proxy reported upstream issue:', reason);
            setScanStatus('Vision API temporarily unavailable — try again');
          } else if (res.status === 500) {
            // Proxy misconfiguration — GCV_API_KEY missing in Vercel env.
            console.error('[GCV] proxy error:', reason);
            setScanStatus('Vision proxy not configured — see console');
          } else {
            console.error('[GCV] error:', reason);
          }
          return '';
        }
        const json = await res.json();
        const text = (json && json.text) || '';
        console.log('[GCV] raw text:', JSON.stringify(text.slice(0, 200)));
        return text;
      } catch (e) {
        console.warn('[GCV] error:', e.message);
        return '';
      }
    }

    // Call match_set_symbol RPC — returns best set match or null if confidence too low
    async function matchSetSymbol(symbolEmbedding) {
      try {
        const res = await sb.rpc('match_set_symbol', {
          query_embedding: symbolEmbedding,
          match_count: 3
        });
        if (res.error) { console.warn('[SymbolMatch]', res.error); return null; }
        const matches = res.data || [];
        console.log('[SymbolMatch]', matches.map(function(m){ return m.set_code+'('+(m.similarity*100).toFixed(1)+'%)'; }).join(' '));
        return (matches.length > 0 && matches[0].similarity > 0.60) ? matches[0] : null;
      } catch(e) {
        console.warn('[SymbolMatch]', e);
        return null;
      }
    }

    // Exact card lookup by set_code + card_number via lookup_card RPC
    async function lookupExactCard(setCode, cardNumber) {
      const variants = [cardNumber];
      const stripped = cardNumber.replace(/^0+/, '');
      if (stripped !== cardNumber) variants.push(stripped);
      for (let i = 0; i < variants.length; i++) {
        try {
          const res = await sb.rpc('lookup_card', { p_set_code: setCode, p_card_number: variants[i] });
          if (!res.error && res.data && res.data.length > 0) {
            return Object.assign({}, res.data[0], { similarity: 1.0, _exact: true });
          }
        } catch(e) { /* try next */ }
      }
      return null;
    }

    // Normalise OCR text before any parsing.
    // All unicode chars are written as \uXXXX escapes and replacements use String.fromCharCode
    // to prevent editor/browser quote-curling from corrupting the function.
    //   ‘/’ (curly apostrophes), ′/‵ (prime), ` (grave) → ‘ straight apos
    //   “/” (curly double quotes), ″ (double prime) → “ straight double-quote
    //   –/—/― (en/em/horizontal bar) → hyphen
    //   ​/‌/‍/﻿ (zero-width) → removed
    function normalizeOcr(text) {
      if (!text) return text;
      // Use String.fromCharCode so no literal quote chars appear in source code.
      var sq  = String.fromCharCode(0x27);  // straight apostrophe U+0027
      var hyp = String.fromCharCode(0x2D);  // hyphen U+002D
      return text
        .replace(/[‘’‚‛′‵]/g, sq)  // curly apostrophes
        .replace(/[–—―]/g, hyp);                   // en/em/horizontal dash
    }

    // Given a parsed card name, derive additional search strings:
    //   expandedName — trainer-card names with missing 's fixed:
    //     "N'Zekrom"  → "N's Zekrom"   (GCV drops the s from single-letter trainers)
    //   pokemonBase  — the Pokémon part stripped of trainer prefix:
    //     "N's Zekrom"          → "Zekrom"
    //     "Lt. Surge's Raichu"  → "Raichu"
    //     "Misty's Tentacruel"  → "Tentacruel"
    function deriveSearchNames(name) {
      if (!name) return { expandedName: null, pokemonBase: null };

      let expanded = name;

      // Fix missing 's: "N'Zekrom" → "N's Zekrom"
      // Pattern: single capital letter + apostrophe + capitalised word (no space between)
      expanded = expanded.replace(/^([A-Z])'([A-Z])/, "$1's $2");

      // Extract Pokémon name after trainer prefix "X's "
      const trainerMatch = expanded.match(/^.+?'s\s+(.+)$/);
      const pokemonBase = trainerMatch ? trainerMatch[1].trim() : null;

      // Only return expandedName if it actually differs from the original
      const expandedName = (expanded !== name) ? expanded : null;

      return { expandedName, pokemonBase };
    }

    // ── Graded slab parser ───────────────────────────────────────────────────
    // Reads OCR text from a slab photo and returns { company, certNumber, grade }
    // or null if no grading company is detected.
    function parseGradedSlab(text) {
      if (!text) return null;
      var t = text.toUpperCase();

      // ── Detect grading company ───────────────────────────────────────
      // Use (?![A-Z]) instead of trailing \b so we still match
      // "PSA10", "BGS9.5", "CGC10" etc. — word boundaries fail between
      // two word chars (e.g., A→1), so /\bPSA\b/ wouldn't match "PSA10"
      // which is a common OCR output from a slab label.
      // Also accept each grader's official tagline, since the company
      // logo (icon next to the letters) frequently OCRs as junk that
      // breaks the leading word boundary (e.g. "DCGC" instead of "CGC").
      var company = null;
      if      (/\bPSA(?![A-Z])/.test(t) || /PROFESSIONAL\s+SPORTS\s+AUTHENTICATOR/i.test(t)) company = 'psa';
      else if (/\b(BGS|BECKETT)(?![A-Z])/.test(t) || /BECKETT\s+GRADING/i.test(t))            company = 'bgs';
      else if (/\bCGC(?![A-Z])/.test(t) || /CERTIFIED\s+GUARANTY\s+COMP/i.test(t))            company = 'cgc';
      else if (/\bSGC(?![A-Z])/.test(t) || /SPORTSCARD\s+GUARANTY/i.test(t)
            || /\bSGC\s+CERTIFIED\b/i.test(t))                                                company = 'sgc';
      // ACE: require "ACE GRADING" phrase or "ACE" + grading word (not "Ace Trainer" cards)
      else if (/ACE[\s\-]GRADING/i.test(t) || (/\bACE\b/.test(t) && /GRAD(ED?|ING)|GEM[\s\-]MINT|PRISTINE/i.test(t))) company = 'ace';
      // TAG Grading (taggrading.com) — match "TAG GRADING" or "TAG GRADED" phrase, avoid "TAG TEAM"
      else if (/TAG[\s\-]GRADING|TAG[\s\-]GRADED|TAG[\s\-]CARDS?/i.test(t) || (/\bTAG\b/.test(t) && /GRAD(ED?|ING)|GEM[\s\-]MINT|PRISTINE/i.test(t) && !/TAG[\s\-]TEAM/i.test(t))) company = 'tag';

      // Fallback: a grader's company logo is often a graphical shield
      // (not letters), so OCR can fail to read its text. When NO
      // grader name OR tagline was matched but the text still has the
      // unmistakable slab-label fingerprint — a year (YYYY), a grade
      // keyword (MINT, GEM MT, NM-MT, etc.), AND a cert-shaped
      // standalone number — infer the grader.
      //
      // Cert-length hint: 12+ digits today is CGC; PSA/BGS/SGC sit in
      // the 7-11 range. Both ranges WILL grow over time as more cards
      // get graded — kept as a soft hint, not a hard rule. PSA is the
      // sensible default since it's the dominant grader by volume.
      if (!company) {
        var hasYear  = /\b(19[5-9]\d|20[0-3]\d)\b/.test(t);
        var hasGrade = /\b(GEM\s*MT|GEM\s*MINT|MINT|NM[\s\-]?MT|NM[\s\-]?M|NEAR\s*MINT|EX[\s\-]?MT|VG[\s\-]?EX|PRISTINE|PERFECT|AUTHENTIC)\b/i.test(t);
        // Strip card fractions first so e.g. 094/165 doesn't pollute the match.
        var noFrac    = text.replace(/\b[A-Z]{0,3}\d{1,4}[\/\\][A-Z]{0,3}\d{1,4}\b/g, ' ');
        var certLong  = noFrac.match(/\b(\d{12,18})\b/); // CGC range, with growth headroom
        var certAny   = noFrac.match(/\b(\d{7,18})\b/);  // any cert-shaped number
        if (hasYear && hasGrade && certAny) {
          company = certLong ? 'cgc' : 'psa';
          console.log('[Scanner] Slab inferred as ' + company.toUpperCase() + ' via heuristic (no grader text was OCR-readable)');
        }
      }
      if (!company) return null;

      // ── Detect grade ────────────────────────────────────────────────
      // Prefer the digit ADJACENT to the company name or to a quality
      // keyword, otherwise we'd just pick the first 1–10 number in the
      // OCR'd text — which on a PSA slab very often reads HP, damage,
      // or attack costs from the card itself before the actual grade.
      var grade = null;
      var GRADE_VALS = '10|9(?:\\.5)?|8(?:\\.5)?|7(?:\\.5)?|6(?:\\.5)?|5(?:\\.5)?|4(?:\\.5)?|[123]';
      var KW = '(?:GEM\\s*MT|GEM\\s*MINT|MINT|NM[\\s\\-]?MT|NM[\\s\\-]?M|NM|EX[\\s\\-]?MT|EX|VG[\\s\\-]?EX|VG|GOOD|POOR|FR|PR|AUTH(?:ENTIC)?)';
      var COMP = company.toUpperCase();

      // 1) Grade attached to or right after the company name (PSA 10, PSA10, PSA GEM MT 10, PSA-10)
      var compRe = new RegExp('\\b' + COMP + '[\\s\\-.:#]*' + KW + '?[\\s\\-.:#]*(' + GRADE_VALS + ')(?![\\d])', 'i');
      var gm1 = text.match(compRe);
      if (gm1) grade = gm1[1];

      // 2) Grade keyword + number anywhere in text (GEM MT 10, MINT 9)
      if (!grade) {
        var kwRe = new RegExp(KW + '[\\s\\-.:#]*(' + GRADE_VALS + ')(?![\\d])', 'i');
        var gm2 = text.match(kwRe);
        if (gm2) grade = gm2[1];
      }

      // 3) Quality-keyword fallback when OCR caught the keyword but
      //    missed the adjacent number (very common — PSA's grade
      //    digit is bolded large but reflective and often blurred).
      //    Defaults to PSA's standard grade for each keyword.
      if (!grade) {
        if      (/GEM[\s\-]?MT|GEM[\s\-]?MINT|PRISTINE|PERFECT/i.test(t)) grade = '10';
        else if (/\bMINT\b/i.test(t) && !/NEAR\s*MINT/i.test(t))           grade = '9';
        else if (/NM[\s\-]?MT|MINT[\s\-]?MT/i.test(t))                     grade = '8';
        else if (/NEAR[\s\-]?MINT|\bNM\b/i.test(t))                        grade = '7';
        else if (/EX[\s\-]?MT|EXCELLENT[\s\-]?MINT/i.test(t))              grade = '6';
        else if (/EXCELLENT|\bEX\b/i.test(t))                              grade = '5';
        else if (/VG[\s\-]?EX|VERY\s*GOOD[\s\-]?EX/i.test(t))              grade = '4';
        else if (/VERY\s*GOOD|\bVG\b/i.test(t))                            grade = '3';
        else if (/\bGOOD\b/i.test(t))                                      grade = '2';
        else if (/\bPOOR\b|\bFR\b|\bPR\b/i.test(t))                        grade = '1';
      }

      // 4) Last-resort: any standalone 1–10 in the OCR (least reliable;
      //    only used when no keyword and no company-adjacent grade hit).
      if (!grade) {
        var gm3 = text.match(new RegExp('\\b(' + GRADE_VALS + ')\\b'));
        if (gm3) grade = gm3[1];
      }

      // ── Detect cert number ──────────────────────────────────────────
      // Strip card fraction patterns (e.g. "94/165") first so they
      // don't pollute the match. Then prefer numbers adjacent to a
      // "CERT" / "CERTIFICATE" keyword for accuracy. PSA certs are
      // typically 8-10 digits but the newest series go up to 11.
      var stripped = text.replace(/\b[A-Z]{0,3}\d{1,4}[\/\\][A-Z]{0,3}\d{1,4}\b/g, ' ');

      // Cert detection — single 7-18 digit range covers every grader
      // today AND leaves headroom as cert numbers continue to grow:
      //   PSA  ~8-11 digits today (was 8 historically, now 10-11)
      //   BGS  ~8-10 digits today
      //   CGC  ~10-13 digits today
      //   SGC  ~7-9 digits today
      //   ACE/TAG ~7-10 digits with optional letter prefix
      // The regex engine matches greedily within the range, so a
      // 13-digit CGC cert won't get truncated to 11 to fit an older
      // bound — and as new graders or longer certs appear, the
      // 7-18 range absorbs them without code changes.
      var cm = stripped.match(/CERT(?:IFICATE|IFICATION)?(?:\s*(?:NUMBER|NO\.?|N°|#|ID))?\s*[:\-#]?\s*(\d{7,18})/i)
            || stripped.match(/\b(\d{7,18})\b/)
            || stripped.match(/\b([A-Z]\d{6,12})\b/);  // letter-prefixed (TAG, ACE)
      var certNumber = cm ? cm[1] : null;

      return { company: company, certNumber: certNumber, grade: grade };
    }
    // ────────────────────────────────────────────────────────────────────────

    // Extract card number like "4/102", "SV001/SV122", "TG01/TG30"
    // Returns { full, num, total } e.g. { full:"094/165", num:"94", total:"165" }
    //
    // Alphanumeric prefixes (TG, GG, SWSH, SVE, etc.) need the digit-only
    // tail for parseInt; we also keep the prefixed forms so the catalog
    // query can match rows stored either way ("TG30" → "30" via num,
    // "TG30" via numRaw). Without this, trainer-gallery / promo cards
    // parsed as NaN and never landed in the strong-tier search.
    //
    // Magic P/T disambiguation: every Magic creature prints its
    // power/toughness as "2/2", "7/7", "5/4" etc. The OCR finds that
    // before the actual collector number (which often sits at the very
    // bottom-left in small text), so we'd parse "2/2" and search for
    // a card numbered 2 in a 2-card set. To avoid this:
    //   • Walk ALL matches in order, not just the first.
    //   • Reject candidates that look like P/T — both sides ≤ 2 digits,
    //     no leading zero, and total < 20.
    //   • Prefer candidates with a leading zero (collector numbers
    //     almost always pad: "027/350", "001/168") or total >= 20.
    function parseCardNumber(text, tcg) {
      if (!text) return null;
      // ── Yu-Gi-Oh card numbers are formatted differently (no fraction):
      //   SET-LANG###[A-Z]   e.g. LDS3-EN001, MAGO-EN012, ROTD-EN045b
      //   TP#-###            tournament packs e.g. TP8-016
      // YGO never uses "###/###" fraction notation, so when the scanner
      // tells us this is a YGO card, look for the SET-LANG pattern first.
      if (tcg === 'yugioh') {
        // YGO set codes can contain digits (RA05, LDS3, etc.) — the
        // previous `[A-Z]{2,5}` rejected anything with digits in the
        // prefix, so RA05-EN085 (Blue-Eyes from Quarter Century Bonanza)
        // never parsed. Allow up to 3 trailing digits in the prefix.
        const ygoRe = /\b([A-Z]{2,5}\d{0,3})-(EN|FR|DE|JP|IT|SP|KR|TC|CH)(\d{3,4})([A-Z])?\b/i;
        const ygoM  = text.match(ygoRe);
        if (ygoM) {
          return {
            full:   `${ygoM[1]}-${ygoM[2]}${ygoM[3]}${ygoM[4]||''}`.toUpperCase(),
            num:    String(parseInt(ygoM[3], 10)),
            numRaw: ygoM[3],
            total:  null,
            setCode: ygoM[1].toUpperCase(),
          };
        }
        const tpRe = /\b(TP\d+)-(\d{3})\b/i;
        const tpM  = text.match(tpRe);
        if (tpM) {
          return {
            full:   `${tpM[1]}-${tpM[2]}`.toUpperCase(),
            num:    String(parseInt(tpM[2], 10)),
            numRaw: tpM[2],
            total:  null,
            setCode: tpM[1].toUpperCase(),
          };
        }
        // fall through to the fraction parser as last resort
      }
      // ── One Piece TCG card numbers: SETCODE-NUMBER (no fraction).
      //   OP06-093 (booster), ST01-001 (starter), EB01-001 (extra
      //   booster), PRB01-001 (premium), P-001 (promo).
      // The slash-based fraction parser below will never match these,
      // so OP scans were silently returning null and the search fell
      // back to name-only hits (12 Peronas with no way to disambiguate).
      // Tolerates a stray space the OCR sometimes inserts ("OP 06-093").
      //
      // No `\b` at the end of the digit capture: OCR routinely sticks
      // a junk digit on the end ("OP12-1086", "P-0933") because the
      // ® / © symbols printed beside the card number get misread as
      // numerals. OP card numbers are always exactly 3 digits, so
      // we greedy-match exactly three and let any trailing OCR
      // noise fall away.
      // ── Gundam Card Game numbers: SETCODE-NUMBER, same shape as OP.
      //   GD01-001 (booster), ST01-001 (starter), R-092 (resource /
      //   single-letter promo), P-001 (promo).
      // Catalog rows store card_number as the full printed string in
      // some sets and the bare number in others, so the SETCODE-NUMBER
      // form gets routed into _cardNumVariants below via setCode +
      // numRaw and the search covers both layouts.
      if (tcg === 'gundam') {
        // Booster / starter format: GD01-001, ST01-001, EB02-045
        const gdSetRe = /\b([A-Z]{1,3})(\d{1,2})\s*-\s*(\d{3,4})/i;
        const gdSetM  = text.match(gdSetRe);
        if (gdSetM) {
          const setCode = (gdSetM[1] + gdSetM[2]).toUpperCase();
          // Gundam catalog numbers are 3 digits; if OCR gave 4, take
          // the first 3 (same junk-trailing-digit fix as OP).
          const num3 = gdSetM[3].slice(0, 3);
          return {
            full:    setCode + '-' + num3,
            num:     String(parseInt(num3, 10)),
            numRaw:  num3,
            total:   null,
            setCode: setCode,
          };
        }
        // Single-letter prefix: R-092 (Resource), P-001 (promo)
        const gdSimpleRe = /\b([A-Z])\s*-\s*(\d{3})/;
        const gdSimpleM  = text.match(gdSimpleRe);
        if (gdSimpleM) {
          return {
            full:    gdSimpleM[1].toUpperCase() + '-' + gdSimpleM[2],
            num:     String(parseInt(gdSimpleM[2], 10)),
            numRaw:  gdSimpleM[2],
            total:   null,
            setCode: gdSimpleM[1].toUpperCase(),
          };
        }
        // fall through if neither pattern matched.
      }
      if (tcg === 'onepiece') {
        const opRe = /\b(OP|ST|EB|PRB?)\s*(\d{1,2})\s*-\s*(\d{3})/i;
        const opM  = text.match(opRe);
        if (opM) {
          const setCode = (opM[1] + opM[2]).toUpperCase();
          return {
            full:    setCode + '-' + opM[3],
            num:     String(parseInt(opM[3], 10)),
            numRaw:  opM[3],
            total:   null,
            setCode: setCode,
          };
        }
        const opPromoRe = /\bP\s*-\s*(\d{3})/;
        const opPM = text.match(opPromoRe);
        if (opPM) {
          return {
            full:    'P-' + opPM[1],
            num:     String(parseInt(opPM[1], 10)),
            numRaw:  opPM[1],
            total:   null,
            setCode: 'P',
          };
        }
        // fall through — OCR sometimes garbles the dash; the fraction
        // parser won't match anyway, so we just return null below.
      }
      const re = /\b([A-Z]{0,4}\d+)\s*[\/\\|]\s*([A-Z]{0,4}\d+)\b/g;
      let m;
      let fallback = null;
      while ((m = re.exec(text)) !== null) {
        const leftDigits  = (m[1].match(/\d+/) || [''])[0];
        const rightDigits = (m[2].match(/\d+/) || [''])[0];
        if (!leftDigits || !rightDigits) continue;
        const numInt   = parseInt(leftDigits,  10);
        const totalInt = parseInt(rightDigits, 10);
        const hasPad   = leftDigits.length > String(numInt).length || rightDigits.length > String(totalInt).length;
        const looksLikePT =
          leftDigits.length <= 2 && rightDigits.length <= 2
          && !hasPad && totalInt < 20;
        if (looksLikePT) {
          // Remember the first P/T-shaped match as a last-resort fallback
          // in case the whole text only contains short fractions (rare
          // — usually means OCR missed the real number entirely).
          if (!fallback) fallback = m;
          continue;
        }
        return {
          full:   m[1] + '/' + m[2],
          num:    String(numInt),
          numRaw: m[1],
          total:  String(totalInt),
        };
      }
      // Topps / merchandise card numbers — bare "#NN" in the corner.
      // No fraction, no set total. Only used when nothing better was
      // found, so it doesn't override real card numbers that have a
      // total component.
      if (!fallback) {
        const toppsMatch = text.match(/^\s*#(\d{1,3})\b/m);
        if (toppsMatch) {
          const n = parseInt(toppsMatch[1], 10);
          return {
            full:   '#' + toppsMatch[1],
            num:    String(n),
            numRaw: toppsMatch[1],
            total:  null,
          };
        }
        // Pokemon Black Star Promos use a no-separator format:
        // SWSH260, SM200, BW101, XY84, HGSS01, DPP56. Two-to-five
        // letter prefix directly followed by 1-4 digits, optionally
        // preceded by the era rotation symbol (which OCR reads as
        // "F", "E", "D" etc — single uppercase letter + space). The
        // dedicated MEP/SVP triple-token pattern below misses these
        // because there's no language code between the set and the
        // number. Catalog rows for these promos store card_number
        // as the bare digits ("260") in some syncs and the full
        // string ("SWSH260") in others, so _cardNumVariants gets the
        // SETCODE-NUMBER form added later via setCode+numRaw.
        if (tcg === 'pokemon' || !tcg) {
          const bspPrefixes = '(SWSH|SM|BW|XY|HGSS|DPP|POP|HS|RC|NP|DV|MCD)';
          const bspRe = new RegExp('\\b' + bspPrefixes + '\\s*(\\d{1,4})\\b', 'i');
          const bspM  = text.match(bspRe);
          if (bspM) {
            const setCode = bspM[1].toUpperCase();
            return {
              full:    setCode + bspM[2],
              num:     String(parseInt(bspM[2], 10)),
              numRaw:  bspM[2],
              total:   null,
              setCode: setCode,
            };
          }
        }

        // Pokemon Center promos use the layout "MEP EN 010" — a 2-5
        // letter set code, a space-separated language tag, then a 2-3
        // digit number. Covers the Mewtwo Center set (MEP), Scarlet &
        // Violet promos (SVP), and anything else following the same
        // convention.
        //
        // Language tag is matched as a generic 2-uppercase-letter
        // group rather than the strict (EN|JP|FR|...) allowlist —
        // OCR routinely misreads the small bottom-corner text and
        // turns "EN" into "IN" / "FN" / "EI", which then trips the
        // strict pattern and the whole card number gets dropped.
        // The surrounding shape (SETCODE + lang + 2-3 digit number)
        // is distinctive enough on its own that loosening the middle
        // is safe in practice — no card rules text matches it.
        // Normalize the lang code to 'EN' when it doesn't match a
        // known one, so downstream code stays happy.
        const promoMatch = text.match(/\b([A-Z]{2,5})\s+([A-Z]{2})\s+(\d{2,3})\b/);
        if (promoMatch) {
          const KNOWN_LANGS = ['EN','JP','FR','DE','IT','SP','KR','TC','CH','PT','NL','RU'];
          const langCode = KNOWN_LANGS.indexOf(promoMatch[2]) >= 0 ? promoMatch[2] : 'EN';
          const n = parseInt(promoMatch[3], 10);
          return {
            full:    `${promoMatch[1]} ${langCode} ${promoMatch[3]}`,
            num:     String(n),
            numRaw:  promoMatch[3],
            total:   null,
            setCode: promoMatch[1],
          };
        }
        return null;
      }
      // No "proper" collector number found — fall back to whatever the
      // first P/T-shaped match was, but mark it. The caller's downstream
      // search will probably miss anyway, but it preserves the old
      // behavior for the (rare) cases where small fractions ARE legit.
      const leftDigits  = (fallback[1].match(/\d+/) || [''])[0];
      const rightDigits = (fallback[2].match(/\d+/) || [''])[0];
      return {
        full:   fallback[1] + '/' + fallback[2],
        num:    String(parseInt(leftDigits,  10)),
        numRaw: fallback[1],
        total:  String(parseInt(rightDigits, 10)),
      };
    }

    // Extract card name — handles all Pokemon card name formats
    // ── Detect Japanese OCR text ─────────────────────────────────────────────
    function isJapaneseOcr(text) {
      // Require at least 4 CJK/kana chars to confidently declare JP mode.
      // A single stray glyph on an English card shouldn't trigger the -0.35 penalty.
      var cjkRe = /[　-鿿豈-﫿＀-￯]/g;
      var matches = text.match(cjkRe);
      return matches !== null && matches.length >= 4;
    }

    // ── OCR language detection — distinguishes JA from ZH and KO ─────────────
    // The legacy isJapaneseOcr() above triggers on ANY CJK character because
    // Japanese kanji shares the same Unicode block (U+4E00–U+9FFF) as Chinese
    // Han ideographs and Korean Hanja. That falsely flagged Chinese cards as
    // Japanese and sent them down the jp-/pd- search path, skipping the
    // cn-pc-/kr-pc- catalog rows entirely.
    //
    // Script-exclusive Unicode ranges:
    //   JA  — must contain Hiragana (U+3041–U+3096) or Katakana (U+30A1–U+30F6)
    //   KO  — must contain Hangul syllables (U+AC00–U+D7AF)
    //   ZH  — Han ideographs (U+4E00–U+9FFF) with NO kana and NO Hangul
    //   EN  — none of the above
    // Threshold: ≥4 script-specific chars (matches legacy policy of ignoring
    // stray CJK glyphs that bleed onto English-card OCR).
    function detectOcrLanguage(text) {
      if (!text) return 'EN';
      // Cards are often majority-EN with a small CJK disclaimer block at
      // the bottom (e.g. Obelisk "Cannot be used in official duels"
      // promo, certain English-region cards reprinted from JP plates).
      // Require both an absolute floor (>=4 chars) AND that the CJK
      // characters make up a meaningful share of the text (>=15%) so
      // a tiny disclaimer doesn't override a large EN body.
      var total  = text.length || 1;
      var meets  = function(arr) { return arr && arr.length >= 4 && (arr.length / total) >= 0.15; };
      var kana   = text.match(/[ぁ-ゖァ-ヶ]/g);  // JA-exclusive
      if (meets(kana)) return 'JA';
      var hangul = text.match(/[가-힯]/g);                 // KO-exclusive
      if (meets(hangul)) return 'KO';
      var han    = text.match(/[一-鿿]/g);                 // Han → ZH (kana ruled out)
      if (meets(han)) return 'ZH';
      return 'EN';
    }

    // ── TCG detector for the scanner ─────────────────────────────────────────
    // Returns 'pokemon' | 'magic' | 'yugioh' | 'onepiece' based on signals in
    // the OCR text. The catalog now spans four games; without this routing,
    // a Magic card scan would search Pokemon rows for matching card numbers
    // and surface noise. Each game has a few high-confidence keyword/format
    // signals that rarely cross-appear:
    //   - Pokemon:    HP value, Weakness/Resistance/Retreat, Pokémon word
    //   - Magic:      mana symbols + creature/instant/sorcery type lines
    //   - Yu-Gi-Oh:   ATK/ + DEF/ format, attribute words (LIGHT/DARK/etc.)
    //   - One Piece:  Leader/Character/Event/Stage type + 'Don!!' icons
    //
    // Scoring approach: count keyword hits per game; highest scorer wins.
    // Pokemon is the default tiebreaker since it's the majority use case.
    // Threshold = 2 hits to claim a game; below that we stay on Pokemon
    // (which is also where non-EN languages route, since only Pokemon has
    // multi-language catalog coverage).
    function detectScanTcg(text) {
      if (!text) return 'pokemon';
      var t = text.toLowerCase();
      var scores = { pokemon: 0, magic: 0, yugioh: 0, onepiece: 0, gundam: 0, dbz: 0 };

      // Pokemon signals
      if (/\bhp\s*\d{2,3}\b/i.test(text))      scores.pokemon += 2;
      if (/\bweakness\b/i.test(t))             scores.pokemon += 1;
      if (/\bresistance\b/i.test(t))           scores.pokemon += 1;
      if (/\bretreat\s*cost\b/i.test(t))       scores.pokemon += 2;
      if (/pok[eé]mon/i.test(t))               scores.pokemon += 1;
      if (/\b(trainer|supporter|stadium)\b/i.test(t)) scores.pokemon += 1;
      if (/\b(basic|stage\s*[12])\b/i.test(t)) scores.pokemon += 1;

      // Magic signals (mana symbols, type line keywords)
      if (/\{[wubrgcx0-9\/]+\}/i.test(text))   scores.magic += 2;
      if (/\b(creature|instant|sorcery|enchantment|artifact|planeswalker)\b/i.test(t)) scores.magic += 2;
      if (/\blegendary\b/i.test(t))            scores.magic += 1;
      if (/\b(equipment|saga|aura)\b/i.test(t)) scores.magic += 1;
      if (/\b\d+\s*\/\s*\d+\b/.test(text) && /\bcreature\b/i.test(t)) scores.magic += 1; // P/T
      // "Mana Value" or older "Converted Mana Cost"
      if (/(mana\s*value|converted\s*mana\s*cost)/i.test(t)) scores.magic += 1;
      // Copyright + artist credit lines are MTG-exclusive in their format:
      //   "™ & © 1993-2024 Wizards of the Coast"
      //   "Illus. John Avon" / "Illus: Rebecca Guay"
      // Token cards in particular often have very little text other than
      // these footer lines, so they're the only reliable TCG signal.
      if (/wizards\s+of\s+the\s+coast/i.test(t)) scores.magic += 2;
      if (/™\s*&?\s*©/i.test(text) || /tm\s*&?\s*©/i.test(t)) scores.magic += 1;
      if (/\billus[\.:]\s*[A-Z]/i.test(text))   scores.magic += 1;
      // Token cards: footer reads "TOKEN" or "0/0 Token Creature - …"
      if (/\btoken\b.*\bcreature\b/i.test(t))   scores.magic += 2;

      // Yu-Gi-Oh signals (ATK/DEF format, attribute words, level stars)
      if (/\batk\s*\/?\s*\d/i.test(text))      scores.yugioh += 2;
      if (/\bdef\s*\/?\s*\d/i.test(text))      scores.yugioh += 2;
      if (/\b(light|dark|earth|water|fire|wind|divine)\b/i.test(t) &&
          /\b(monster|spell|trap)\b/i.test(t)) scores.yugioh += 2;
      if (/\beffect\s*monster\b/i.test(t))     scores.yugioh += 1;
      if (/\b(fusion|synchro|xyz|link|ritual|pendulum)\b/i.test(t)) scores.yugioh += 1;
      if (/\bspell\s*card\b/i.test(t) || /\btrap\s*card\b/i.test(t)) scores.yugioh += 1;

      // One Piece signals
      if (/\bdon\s*!!?/i.test(t))              scores.onepiece += 2;
      if (/\b(leader|character|event|stage)\b/i.test(t) &&
          /\bcost\b/i.test(t))                 scores.onepiece += 2;
      if (/\b(slash|strike|special|ranged)\b/i.test(t)) scores.onepiece += 1;
      if (/\b(op|st|eb|pr)\d+-\d+/i.test(text)) scores.onepiece += 2; // OP01-001 / ST01-001 set codes
      if (/\bstraw\s*hat|navy|alabasta|wano\b/i.test(t)) scores.onepiece += 1;

      // Gundam Card Game signals
      // Card types: Unit, Pilot, Command, Base, Resource (Resource is the
      // most distinctive — almost never appears on other TCGs in this set).
      if (/\b(unit|pilot|command|base|resource)\b/i.test(t) &&
          /\b(ap|hp|cost|lv)\b/i.test(t))      scores.gundam += 2;
      if (/\bmobile\s*suit\b/i.test(t))        scores.gundam += 2;
      if (/\bpilot\s*skill\b/i.test(t))        scores.gundam += 2;
      // Set codes — Gundam pokedata sync uses GD/ST/EB prefixes (e.g. GD01-001).
      // ST overlaps with One Piece starter decks, so we don't double-count
      // ST hits — those are scored under One Piece if other OP signals fire,
      // and here only when paired with a Gundam-only word.
      if (/\bgd\d+-\d+/i.test(text))           scores.gundam += 2;
      if (/\b(earth\s*federation|zeon|principality|colony)\b/i.test(t)) scores.gundam += 1;
      // "AP" + "HP" together (Gundam's stat pair) is a strong signal
      if (/\bap\s*\d+/i.test(text) && /\bhp\s*\d+/i.test(text) &&
          /\b(unit|pilot)\b/i.test(t))         scores.gundam += 1;

      // Dragon Ball Z TCG signals (Panini/Score era)
      // Style is the bedrock signal: every personality + non-Z card has a
      // Style line (Red/Blue/Orange/Black/Saiyan/Namekian/Freestyle).
      if (/\bstyle\s*[:=]?\s*(red|blue|orange|black|saiyan|namekian|freestyle)\b/i.test(t)) scores.dbz += 2;
      if (/\bpower\s*level\b/i.test(t) || /\bpwr\b/i.test(t)) scores.dbz += 2;
      if (/\b(combat|non[-\s]?combat)\b/i.test(t) && /\bcard\b/i.test(t)) scores.dbz += 2;
      // Personality cards: "Goku Level 1", "Vegeta Lv 3", etc. Pair Lv with
      // a known DBZ name to avoid matching Pokemon's level system.
      if (/\b(goku|vegeta|gohan|piccolo|frieza|cell|trunks|krillin|tien)\b/i.test(t) &&
          /\b(lv\.?|level)\s*\d/i.test(t))     scores.dbz += 2;
      // Set codes — DBZ pokedata sync uses DBZ/DB prefixes (e.g. DB1-001)
      if (/\b(dbz|db)\d+-\d+/i.test(text))     scores.dbz += 2;
      if (/\b(saiyan|namekian|frieza\s*saga|cell\s*saga|buu\s*saga)\b/i.test(t)) scores.dbz += 1;

      // Pick highest. Threshold = 2 to claim non-Pokemon (avoids stray
      // single-word hits dragging a Pokemon card into another search).
      var best  = 'pokemon';
      var bestN = scores.pokemon;
      ['magic','yugioh','onepiece','gundam','dbz'].forEach(function(g) {
        if (scores[g] > bestN && scores[g] >= 2) { best = g; bestN = scores[g]; }
      });
      try { console.log('[Scanner] TCG detect:', JSON.stringify(scores), '→', best); } catch(_) {}
      return best;
    }

    // ── Extract card name from Japanese OCR text ──────────────────────────────
    // JP layout: card type (グッズ), furigana fragments (1-3 kana), then the actual name
    function parseJapaneseCardName(lines) {
      // Known JP card-type keywords to skip. たね = "Basic" stage label;
      // LEGEND = legendary stage label; BASIC matches the English label
      // OCR sometimes catches on the Pokemon card top-banner.
      const JP_SKIP = /^(たね|LEGEND|BASIC|グッズ|トレーナーズ|サポート|スタジアム|ポケモン|エネルギー|どうぐ|HP\d+|\d+|エイチピー|むしょく|ひこう|ほのお|みず|くさ|かみなり|エスパー|ファイト|あく|はがね|ドラゴン|フェアリー|アマルスへ進化|進化|特性|とくせい|弱点|抵抗力|にげる|Illus|©|www\.)$/;
      // Furigana detection — true furigana are small HIRAGANA subscripts
      // printed above kanji (U+3041–U+3096). Short KATAKANA lines are
      // typically card names (ピッピ = Pippi/Clefable, コダック = Psyduck,
      // ナマズン etc.) not furigana, so don't blanket-skip them.
      // Restrict the test to lines that contain hiragana — pure-katakana
      // lines now pass through to the name-acceptance check below.
      const isFurigana = (s) => s.length <= 4
        && /^[぀-ヿ]+$/.test(s)
        && /[ぁ-ゖ]/.test(s);

      for (let i = 0; i < Math.min(15, lines.length); i++) {
        const line = lines[i];
        if (isFurigana(line)) continue;
        if (JP_SKIP.test(line)) continue;
        // Skip evolution stage labels: "1進化", "2進化", "たね", "LEGEND" etc.
        if (/^\d+進化$/.test(line)) continue;
        // Skip "XからXX進化" (evolves-from text): "ゴーストから進化"
        if (/から進化/.test(line)) continue;
        // Accept lines that contain kanji/kana and are reasonably sized
        if (/[　-鿿぀-ヿ]/.test(line) && line.length >= 3 && line.length <= 35) {
          // Strip trailing ASCII noise that OCR appends (e.g. "メガゲンガー CX3500" → "メガゲンガー")
          // Preserve known name suffixes: "ex", "GX", "V", "VMAX", "VSTAR" handled by keeping whole line if short
          const cjkPrefix = line.match(/^([　-鿿一-鿿぀-ヿ豈-﫿ｦ-ﾟ・ー～「」。、]+)/);
          if (cjkPrefix && cjkPrefix[1].length >= 2) return cjkPrefix[1].trim();
          return line;
        }
      }
      return null;
    }

    // ── Extract card name from Chinese OCR text ──────────────────────────────
    // Chinese cards have a different layout from Japanese: no furigana, no
    // kana, and card names are often very short (e.g. 喵喵 = Meowth, 2 chars).
    // The JP parser rejects ≤2-char lines, which would skip valid CN names.
    // Stage labels and other skip-list items in Chinese ("基础" = Basic,
    // "1阶进化" = Stage 1, etc.) need their own list.
    function parseChineseCardName(lines) {
      // Stage labels, attribute names, mechanical keywords. Anything that's
      // ON a card but isn't the card name. Plain stage label "基础" (Basic)
      // is the most common one to skip past.
      const ZH_SKIP = /^(基础|基础宝可梦|1阶进化|2阶进化|阶进化|进化|特性|招式|弱点|抵抗力|抗性|撤退|草|火|水|雷|超|斗|恶|钢|龙|妖精|无色|HP\s*\d+|\d+|Illus|©|www\.|GAME\s*FREAK|Pok[eé]mon|Nintendo|Creatures)$/i;

      for (let i = 0; i < Math.min(15, lines.length); i++) {
        const line = lines[i];
        if (ZH_SKIP.test(line)) continue;
        // "从X进化" / "由X进化而来" (evolves-from text) — usually appears below
        // the name and isn't the name itself
        if (/从.+进化/.test(line) || /由.+进化/.test(line)) continue;
        // Lines must contain Han ideographs (CN names are always Chinese chars)
        if (!/[一-鿿]/.test(line)) continue;
        // Accept lines that are 2-30 chars and look like a name. The 2-char
        // minimum is the key difference vs the JP parser — 喵喵, 皮卡丘
        // (Pikachu), 杰尼龟 (Squirtle) all fit.
        if (line.length >= 2 && line.length <= 30) {
          // Strip trailing ASCII noise (e.g. "喵喵 CX3500" → "喵喵")
          const hanPrefix = line.match(/^([一-鿿·・\s]+)/);
          if (hanPrefix && hanPrefix[1].trim().length >= 2) return hanPrefix[1].trim();
          return line;
        }
      }
      return null;
    }

    // ── Extract card name from Korean OCR text ───────────────────────────────
    // Korean cards use Hangul + occasional Hanja. Card names are typically
    // 2-6 syllable blocks (피카츄 = Pikachu, 꼬부기 = Squirtle). Same general
    // shape as the JP parser but with Hangul instead of kana, and Korean
    // skip terms.
    function parseKoreanCardName(lines) {
      const KO_SKIP = /^(기본|1단진화|2단진화|진화|특성|기술|약점|저항력|후퇴|풀|불|물|번개|초|격투|악|강철|드래곤|페어리|무색|HP\s*\d+|\d+|Illus|©|www\.|GAME\s*FREAK|Pok[eé]mon|Nintendo|Creatures)$/i;
      for (let i = 0; i < Math.min(15, lines.length); i++) {
        const line = lines[i];
        if (KO_SKIP.test(line)) continue;
        // Lines must contain Hangul
        if (!/[가-힯]/.test(line)) continue;
        if (line.length >= 2 && line.length <= 30) {
          const hangulPrefix = line.match(/^([가-힯·\s]+)/);
          if (hangulPrefix && hangulPrefix[1].trim().length >= 2) return hangulPrefix[1].trim();
          return line;
        }
      }
      return null;
    }

    // ── Topps layout detector ───────────────────────────────────────
    // Returns { name, num } when the OCR line shape matches a Topps
    // Pokemon card (#NN line, Pokemon brand line, then an ALL-CAPS
    // card name). Used by parseCardName for the name extraction AND
    // by runMatch to scope the catalog search to topps- ids so we
    // don't surface random Pokemon TCG cards numbered 45.
    function detectToppsLayout(lines) {
      if (!Array.isArray(lines)) {
        if (typeof lines === 'string') lines = lines.split('\n').map(function(l){return l.trim();}).filter(Boolean);
        else return null;
      }
      const TOPPS_NUM   = /^#\d{1,3}$/;
      const POKEMON_ISH = /^pok[eé\']?[mM][oO0aäAÄ][nNyY][!\.]?$/i;
      const TOPPS_NAME  = /^[A-Z][A-Z'\-\s]{2,18}$/;
      let toppsNumIdx   = -1;
      let toppsBrandIdx = -1;
      let toppsNum      = null;
      for (let i = 0; i < Math.min(6, lines.length); i++) {
        if (toppsNumIdx < 0 && TOPPS_NUM.test(lines[i])) {
          toppsNumIdx = i;
          toppsNum = lines[i].replace('#', '');
        }
        if (toppsBrandIdx < 0 && POKEMON_ISH.test(lines[i])) toppsBrandIdx = i;
      }
      if (toppsNumIdx < 0 || toppsBrandIdx < 0) return null;
      for (let j = toppsBrandIdx + 1; j < Math.min(toppsBrandIdx + 5, lines.length); j++) {
        if (TOPPS_NAME.test(lines[j])) {
          const titled = lines[j].toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function(_, p, c) {
            return p + c.toUpperCase();
          });
          return { name: titled, num: toppsNum };
        }
      }
      return { name: null, num: toppsNum };
    }

    function parseCardName(text, tcg) {
      if (!text) return null;
      text = normalizeOcr(text);  // normalise smart quotes/dashes before parsing
      const lines = text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);

      // ── Non-English card — dispatch to language-specific parser ──────────
      var lang = detectOcrLanguage(text);
      if (lang === 'JA') return parseJapaneseCardName(lines);
      if (lang === 'ZH') return parseChineseCardName(lines);
      if (lang === 'KO') return parseKoreanCardName(lines);

      // ── ALL-CAPS branch (YGO + MTG tokens) ───────────────────────────────
      // Both Yu-Gi-Oh and Magic-the-Gathering tokens print the card name in
      // SOLID CAPS ("BLUE-EYES WHITE DRAGON", "LASERBEAK", "ANGEL WARRIOR").
      // The default NAME_RE rejects all-caps as background noise (HAT, ATS,
      // OLUME, MUTE) which is the right call for Pokemon — but it strips
      // out the actual card names on YGO + MTG-token scans.
      //
      // Heuristic: if we know the scan is yugioh, scan the first ~8 lines
      // for the first ALL-CAPS line that isn't an attribute label, type
      // line, set code, or token keyword. For MTG tokens, the scan TCG is
      // still 'magic', so we additionally activate this branch when any
      // early line matches the MTG token signature ("Token Creature -").
      const ALLCAPS_RE   = /^[A-Z][A-Z0-9\s\-'&!?.,]{1,40}$/;
      const YGO_SKIP     = /^(EARTH|FIRE|WATER|WIND|LIGHT|DARK|DIVINE|MONSTER|SPELL|TRAP|EFFECT|FUSION|SYNCHRO|XYZ|LINK|RITUAL|PENDULUM|ATK|DEF|LEVEL|RANK|YU-?GI-?OH|TM|TCG|NORMAL\s+MONSTER|SPELL\s+CARD|TRAP\s+CARD|CONTINUOUS|QUICK-PLAY|FIELD\s+SPELL|EQUIP\s+SPELL|COUNTER\s+TRAP)$/;
      const TOKEN_SKIP   = /^(TOKEN|FLYING|TRAMPLE|HEXPROOF|LIFELINK|VIGILANCE|DEATHTOUCH|HASTE|REACH|MENACE|FIRST\s+STRIKE|DOUBLE\s+STRIKE|INDESTRUCTIBLE|FLASH|DEFENDER|WARD|PROTECTION|TOUGHNESS|POWER|SHROUD|CREATURE|ARTIFACT|ENCHANTMENT|LAND|INSTANT|SORCERY|PLANESWALKER|BATTLE)$/;
      const looksLikeMtgToken = lines.slice(0, 6).some(function(l){
        return /token\s+(legendary\s+)?(artifact\s+|enchantment\s+)?creature/i.test(l);
      });
      var wantAllCaps = (tcg === 'yugioh') || looksLikeMtgToken;
      if (wantAllCaps) {
        // Walk ALL early lines, score each candidate, return the best.
        // Single-pass first-match was returning OCR fragments like
        // "HIGHE" when the real name ("BLUE-EYES WHITE DRAGON") came
        // a line later. Now we collect every candidate that passes
        // the skip filters and pick the LONGEST one — real card names
        // are basically always the longest all-caps line on a card
        // face, while OCR fragments are short.
        const ALLCAPS_MIN_LEN = 6;  // shorter than this is almost certainly OCR junk
        let bestCandidate = null;
        for (let i = 0; i < Math.min(10, lines.length); i++) {
          const raw = lines[i];
          if (!raw || raw.length < ALLCAPS_MIN_LEN || raw.length > 40) continue;
          if (!ALLCAPS_RE.test(raw)) continue;
          // Reject pure-digit OCR fragments ("0123") and isolated set codes
          if (/^[A-Z]{2,5}-?\d{3,4}$/.test(raw)) continue;
          // Reject the YGO / MTG-token keyword vocabulary
          if (YGO_SKIP.test(raw)) continue;
          if (TOKEN_SKIP.test(raw)) continue;
          // Reject MTG type lines even when all-caps
          if (/^(TOKEN\s+)?(LEGENDARY\s+|SNOW\s+|BASIC\s+|TRIBAL\s+)?(ARTIFACT\s+|ENCHANTMENT\s+|LAND\s+|CREATURE|SORCERY|INSTANT|PLANESWALKER|BATTLE|VEHICLE)(\s*[-—–:].+)?$/.test(raw)) continue;
          // Reject single-token OCR fragments (like "HIGHE") that don't
          // look like real names — real all-caps card names almost
          // always have 2+ words OR a hyphen.
          const wordCount = raw.split(/\s+/).filter(Boolean).length;
          if (wordCount < 2 && !raw.includes('-')) continue;
          if (!/[A-Z]{2,}/.test(raw)) continue;
          if (!bestCandidate || raw.length > bestCandidate.length) {
            bestCandidate = raw;
          }
        }
        if (bestCandidate) {
          // Title-case for the catalog ilike search ("BLUE-EYES WHITE
          // DRAGON" → "Blue-eyes White Dragon"). Catalog stores names in
          // proper case so a literal all-caps query never matches.
          const titled = bestCandidate.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function(_, p, c){
            return p + c.toUpperCase();
          });
          return _cleanCardName(titled);
        }
      }

      const SUFFIX    = /^(VSTAR|VMAX|GX|EX|V|VUNION|TAG\s*TEAM)$/i;
      const STAGE_PRE = /^(Basic|Stage\s*[12])\s+/i;  // stage as prefix on same line
      const STAGE     = /^(Basic|Stage\s*[12]|STAGE)$/i; // stage alone on its own line (incl. bare STAGE from OCR-truncated label)
      // "Basic Pokémon", "Stage 2 Pokémon" etc. are type-label lines
      // that the v464 STAGE_PRE guard correctly stops returning. But
      // the fallback later in this loop accepts any title-case line
      // not in SKIP — so the whole "Basic Pokémon" string slipped
      // through and became the parsed name on Base Set Chansey. List
      // them explicitly so the fallback rejects them too.
      const SKIP      = /^(Basic|Basic\s+Pok[eé]mon|Stage\s*[12](\s+Pok[eé]mon)?|STAGE|VMAX|VSTAR|GX|EX|V|VUNION|TAG\s*TEAM|HP|\d+|Trainer|Item|Stadium|Supporter|Energy|Pok[eé]mon|Weakness|Resistance|Retreat|Illustrator|Regulation|©|www\.|Evolves|Ability|Rule|DX|VOLUME|RASH|TRASH|HATS?|MUTE|MAX|MIN|MOD)$/i;
      // Evolution prefix lines on Stage 1 / Stage 2 cards: "Evolves from
      // Eevee", "Evolves from Kadabra", "Put Venusaur on the Stage I card".
      // The fallback parser was returning these as the card name on
      // Flareon / Alakazam / Venusaur scans. Reject them outright so
      // the loop falls through to find the real name a line or two
      // later ("Flareon", "Alakazam", "Venusaur").
      const EVOLVE_PREFIX = /^(Evolves\s+from\s+|Put\s+\w+\s+on\s+the\s+(Basic|Stage)\b)/i;
      // Magic type-line skip. Every Magic card prints a TYPE line below
      // the title art: "Creature - Beast", "Artifact Creature - Construct",
      // "Legendary Artifact Creature - Necron", "Token Creature - X" etc.
      // Without this skip the parser was returning the type line as the
      // card name (Szarekh→"Legendary Artifact Creature - Necron",
      // Astartes Warrior token→"Token Creature-Astartes Warrior") so
      // the catalog name search never hit anything sensible. Real Magic
      // names always sit above the mana cost row; once we skip the type
      // lines, the name-detection loop finds them on the next pass.
      const MAGIC_TYPE_LINE = /^(Token\s+)?(Legendary\s+|Snow\s+|World\s+|Basic\s+|Tribal\s+)*(Artifact\s+|Enchantment\s+|Land\s+|Creature|Sorcery|Instant|Planeswalker|Battle|Kindred|Vehicle)(\s*[-—–:].+)?$/i;
      // Card names are ALWAYS mixed case ("Espurr", "Mewtwo", "Ho-Oh"),
      // never SHOUTING. The (?=...) lookahead requires at least one
      // lowercase letter — this rejects all-uppercase background OCR
      // junk like "HAT", "OLUME", "ATS", "LUME" that bleeds in from
      // desk pads, keyboards, and labels behind the card.
      const NAME_RE   = /^(?=.*[a-zà-ö])[A-ZÀ-Ö][a-zA-ZÀ-ö0-9\s\-'éèê&]+$/;

      // ── Topps / vintage merchandise layout ──────────────────────────
      // Topps Pokemon cards (the 1999-2001 sticker/foil set) print the
      // card in the layout:
      //   #45
      //   POKEMON   (often OCR'd as PokeMON / PokeMoy / Pok'emon)
      //   VILEPLUME
      // The standard parser misses this because:
      //   - The card name is ALL-CAPS (NAME_RE requires a lowercase
      //     letter to filter out background noise)
      //   - SKIP catches "Pokemon" but if the OCR mangles it to PokeMoy
      //     or similar, SKIP misses it and the brand line gets returned
      //     as the name instead.
      // Uses the shared detectToppsLayout() helper so runMatch can also
      // know to scope its catalog search to topps- ids — without that
      // scope a Topps Vileplume scan returns Pokemon TCG cards numbered
      // 45 from any random set instead of the actual Topps Vileplume.
      const toppsDetect = detectToppsLayout(lines);
      if (toppsDetect && toppsDetect.name) return _cleanCardName(toppsDetect.name);

      for (let i = 0; i < Math.min(12, lines.length); i++) {
        const line = lines[i];

        // Pattern: "BASIC Reshiram&" — stage prefix inline with partial name
        // next line may continue the name ("Charizard")
        if (STAGE_PRE.test(line)) {
          let namePart = line.replace(STAGE_PRE, '').trim();
          // Normalize missing space before & ("Reshiram&" → "Reshiram &")
          namePart = namePart.replace(/(\S)&/, '$1 &');
          if (namePart.endsWith('&') && i + 1 < lines.length) {
            namePart = namePart + ' ' + lines[i + 1].trim();
          }
          // Validate that what's left after stripping the stage prefix
          // isn't itself a keyword. "Basic Pokémon" is a TYPE LABEL on
          // old-school Wizards cards (Chansey, Magmar, Geodude…) — stripping
          // "Basic " leaves "Pokémon" which is in SKIP. Without this check
          // the parser returned "Pokémon" as the card name for every Base
          // Set basic. Same guard for "Basic Trainer" etc.
          if (namePart.length > 1 && !SKIP.test(namePart) && !EVOLVE_PREFIX.test(namePart)) {
            return _cleanCardName(namePart);
          }
          // Fall through to the next pattern instead of returning — the
          // actual name probably sits on the line below ("Basic Pokémon
          // \n Chansey \n 120 HP"). The fallback loop handles it.
        }

        // Pattern: "VSTAR Lugia" — type suffix before name, flip to "Lugia VSTAR"
        const prefixMatch = line.match(/^(VSTAR|VMAX|GX|EX|V)\s+([A-ZÀ-Ö][a-zA-ZÀ-ö\s\-'éèê&]+)$/);
        if (prefixMatch) {
          // Strip OCR-noise trailing suffix words that get captured into
          // the name match: "VSTAR Charizard STAR" → m[2] = "Charizard
          // STAR" where the trailing STAR is just OCR repeating the
          // prefix from the card's display art. Drop any of the same
          // suffix words off the end so we don't double-stamp the name.
          const cleanedName = prefixMatch[2]
            .replace(/\s+(STAR|MAX|VSTAR|VMAX|VUNION)\s*$/i, '')
            .trim();
          if (cleanedName.length > 0) {
            return _cleanCardName(cleanedName) + ' ' + prefixMatch[1].toUpperCase();
          }
        }

        // Pattern: "Lugia\nVSTAR" — name then suffix on next line
        if (i + 1 < lines.length && SUFFIX.test(lines[i + 1])) {
          if (NAME_RE.test(line) && !SKIP.test(line) && !MAGIC_TYPE_LINE.test(line) && line.length > 1 && line.length < 35) {
            return _cleanCardName(line) + ' ' + lines[i + 1].replace(/\s+/g, ' ').toUpperCase();
          }
        }

        // Pattern: "Reshiram&\nCharizard" — name split across lines by ampersand
        if (line.endsWith('&') && i + 1 < lines.length) {
          const joined = line + ' ' + lines[i + 1].trim();
          if (NAME_RE.test(joined) && joined.length < 50) return _cleanCardName(joined);
        }

        // Pattern: "Basic\nDucklett" — stage alone, name follows.
        // The next line is where HP often glues onto the name in OCR
        // ("Mega Pyroar ex340", "Mega Floette ex 250") — _cleanCardName
        // strips trailing digit runs so the search query stays clean.
        //
        // Stage-2 cards lay out as STAGE 2 / Evolves from X / RealName
        // on three lines, so the "next" line after STAGE is often the
        // "Evolves from" line. Walk forward through up to 3 lines and
        // skip anything matching EVOLVE_PREFIX or SKIP. Original code
        // returned the first next line unconditionally, which is why
        // Fossil Gengar parsed as "Evolves from Haunter".
        if (STAGE.test(line)) {
          for (let k = 1; k <= 3 && i + k < lines.length; k++) {
            const next = lines[i + k].trim();
            if (!next) continue;
            if (SKIP.test(next)) continue;
            if (EVOLVE_PREFIX.test(next)) continue;
            if (MAGIC_TYPE_LINE.test(next)) continue;
            if (NAME_RE.test(next) && next.length > 1 && next.length < 40) {
              return _cleanCardName(next);
            }
            // First non-skip line was bad too — stop scanning so we
            // don't accidentally grab an attack name from deeper down.
            break;
          }
        }

        // Fallback: first valid title-case line that isn't a keyword
        // and isn't a Magic type line ("Creature - Beast" etc.) and
        // isn't an evolution-prefix line ("Evolves from Eevee").
        if (!SKIP.test(line) && !MAGIC_TYPE_LINE.test(line) && !EVOLVE_PREFIX.test(line) && NAME_RE.test(line) && line.length > 2 && line.length < 40) {
          return _cleanCardName(line);
        }
      }
      return null;
    }

    // Strip trailing OCR junk that gets jammed onto the name line.
    // Common cases the GCV OCR produces:
    //   "MewtwoEX 180 HP O"  → "MewtwoEX"   (HP/damage glued to name)
    //   "Charizard 60 HP"    → "Charizard"
    //   "Ho-Oh 160"          → "Ho-Oh"
    // Anything from the first standalone digit onward is treated as
    // attack/HP/junk and removed.
    function _cleanCardName(name) {
      if (!name) return name;
      // Drop everything from the first run of digits onward
      var m = name.match(/^([^\d]+?)(?:\s+\d|HP\s*\d|\d).*$/i);
      if (m && m[1].trim().length >= 3) name = m[1];
      // OCR sometimes doubles the trailing letter on "ex" cards — the
      // visual "X" (large pictograph) is captured as both the printed
      // X and a phantom shadow x. Common with Mega Charizard X
      // → "Mega Charizard Xx", Pikachu X → "Pikachu Xx" etc. Strip
      // the phantom lowercase letter when it duplicates an uppercase
      // single-letter trailing suffix.
      name = name.replace(/\b([A-Z])\1?[a-z]\s*$/, function(m, cap){
        return cap;
      });
      return name.trim();
    }

    // ── Scanner — full-image OCR + name×number search + CLIP fallback ──────────
    // opts.silent=true → skip all UI updates, return match array (used by multi-scan)
    async function runMatch(dataURL, opts) {
      const silent = !!(opts && opts.silent);

      // Stash the user's scan photo so that when they confirm a match,
      // we can upload it as the binder card's image instead of using the
      // catalog stock photo. Silent (multi-scan / batch) calls don't
      // overwrite the single-scan capture — they're not the user-facing
      // path. _scanCapturedDataUrl is consumed by confirmScanMatch and
      // cleared on save / scanner close.
      if (!silent && dataURL && typeof dataURL === 'string' && dataURL.startsWith('data:')) {
        window._scanCapturedDataUrl = dataURL;
      }

      // ── Per-tier monthly scanner usage gate (non-silent scans only) ─────────
      if (!silent && currentUser) {
        const used  = getUsageCount('scan');
        const limit = scannerLimit();
        if (used >= limit) {
          // Determine which tier to upsell to
          const nextTier = tierAtLeast('enthusiast') ? null
                         : tierAtLeast('collector') ? 'enthusiast' : 'collector';
          const remaining = 'Monthly scan limit reached (' + limit + '/month).';
          setScanStatus(remaining + (nextTier ? ' Upgrade for more.' : ' Contact us to move to Shop.'));
          if (nextTier) {
            setTimeout(() => openPricingModalWithPromo(nextTier), 900);
          } else {
            // Vendor at limit — direct to shop contact form
            setTimeout(() => { openPricingModal(); setTimeout(openShopIntake, 300); }, 900);
          }
          return [];
        }
        // Count the scan
        incrementUsage('scan');
        try { checkBadge_scanner(); } catch(_) {}
        // Show remaining uses for free tier as a soft nudge
        if (!tierAtLeast('collector')) {
          const left = limit - used - 1;
          if (left <= 2) setScanStatus(left === 0
            ? 'Last free scan this month — upgrade for more.'
            : left + ' free scan' + (left === 1 ? '' : 's') + ' remaining this month.');
        }
      }

      if (!silent) setScanStatus('Reading card text…');
      try {
        // Step 1: OCR the full image + start CLIP embedding in parallel
        // OCR a top+bottom STITCHED composite of the card image (drops
        // the middle artwork, 2× upscales the bottom band where the
        // tiny set code lives). One Vision call, but the text-budget
        // gets spent on the two regions that actually carry text
        // instead of being wasted on holo sparkle in the artwork.
        //
        // If the stitch helper fails (image load error, canvas issue),
        // fall back to OCRing the original dataURL — same behavior as
        // before this change.
        const _stitchedP = _stitchForOcr(dataURL).then(function(stitchedUrl) {
          return ocrCardText(stitchedUrl);
        }).catch(function(e) {
          console.warn('[Scanner] stitched OCR failed, falling back to full image:', e);
          return ocrCardText(dataURL);
        });
        const [rawFullText, fullEmbedding] = await Promise.all([
          _stitchedP,
          window._getClipEmbedding(dataURL),
        ]);

        // Normalise smart quotes / dashes from GCV before any parsing
        const fullText = normalizeOcr(rawFullText);

        // Warn the user if OCR returned nothing — usually means API key issue
        if (!silent && !rawFullText) {
          setScanStatus('⚠ No text detected — check lighting or try a clearer photo');
          console.warn('[Scanner] GCV returned empty — API key may be rate-limited or expired');
        }

        // ── Graded slab detection ────────────────────────────────────────────
        window._detectedSlab = parseGradedSlab(fullText);
        if (window._detectedSlab) {
          console.log('[Scanner] Slab detected:', window._detectedSlab);
          // ALWAYS hand off to the slab handler when a slab is detected.
          // Previously this was gated on certNumber being truthy — but
          // when the OCR sees the company name (PSA, BGS, etc.) yet
          // can't quite read the small cert digits, falling through to
          // regular card matching shows the card-picker instead of the
          // paste-cert UI. The slab handler now gracefully shows a
          // manual cert-entry input + paste-text area when the cert
          // number is missing.
          if (!silent) {
            await handleSlabScan(window._detectedSlab);
            return [];
          }
        }

        // Detect language + TCG FIRST so the parsers can route by game.
        // Yu-Gi-Oh has SHOUTED card names ("BLUE-EYES WHITE DRAGON") and
        // a SET-LANG### card-number format (not Pokemon's ###/### fraction).
        // MTG tokens also print names in solid caps. Both cases need a
        // game hint passed into parseCardName/parseCardNumber.
        const ocrLang     = detectOcrLanguage(fullText);    // 'JA' | 'ZH' | 'KO' | 'EN'
        const isJpOcr     = ocrLang === 'JA';                // back-compat alias
        // Non-EN routes to Pokemon (only Pokemon has multi-lang catalog).
        const scanTcg = (ocrLang === 'EN') ? detectScanTcg(fullText) : 'pokemon';

        // parseCardNumber now returns { full, num, numRaw, total, setCode? }
        const parsed     = parseCardNumber(fullText, scanTcg);
        let numStripped = parsed ? parsed.num    : null;  // "94"
        let numRaw      = parsed ? parsed.numRaw : null;  // "094"
        const numTotal    = parsed ? parsed.total  : null;  // "165" — set base size fingerprint
        const parsedSetCode = parsed ? parsed.setCode || null : null;  // YGO: "RA05", "LDS3", etc.

        // Topps layout detection — when a card has the #NN / Pokemon /
        // ALL-CAPS NAME signature, restrict the catalog search to
        // topps- id rows so we don't surface unrelated Pokemon TCG
        // cards that happen to share the same collector number.
        const _toppsHit = detectToppsLayout(fullText);
        const isTopps   = !!(_toppsHit && _toppsHit.num);
        // If parseCardNumber missed (no fraction), use the Topps num.
        if (isTopps && !numStripped) {
          numStripped = _toppsHit.num;
          numRaw = _toppsHit.num;
        }
        const cardName    = parseCardName(fullText, scanTcg);

        // Derive extra name variants for trainer-card mismatches:
        //   "N'Zekrom" → expandedName="N's Zekrom", pokemonBase="Zekrom"
        //   "Misty's Tentacruel" → expandedName=null, pokemonBase="Tentacruel"
        const { expandedName, pokemonBase: trainerPokemon } = deriveSearchNames(cardName);

        console.log('[Scanner] OCR raw:', JSON.stringify(rawFullText.slice(0,120)));
        console.log('[Scanner] parsed → number:', parsed?.full, '| num:', numStripped, '| total:', numTotal, '| name:', cardName, '| expanded:', expandedName, '| pokemon:', trainerPokemon, '| lang:', ocrLang);

        if (!silent) setScanStatus('Searching catalog…');

        // Factory — Supabase query builders are mutable, so create a fresh one each time.
        // Scope to the DETECTED TCG: `detectScanTcg` reads the OCR text and
        // picks pokemon/magic/yugioh/onepiece based on game-specific keywords
        // (HP+Retreat for Pokemon, mana symbols + creature/instant for Magic,
        // ATK/DEF + attribute words for Yu-Gi-Oh, Don!! + Leader/Character
        // for One Piece). Without this routing, a Magic card scan would
        // hit Pokemon rows whose card_number happens to match and surface
        // 100+ false positives. Defaults to pokemon when uncertain — the
        // majority use case + matches the Pokemon-specific OCR parser.
        // q() — the factory for every catalog SQL query in this match
        // pipeline. Adds a `topps-` id prefix scope when the OCR layout
        // signature said this is a Topps card, otherwise the search
        // would return unrelated Pokemon TCG cards that happen to
        // share the same collector number.
        // POS sale mode: restrict every catalog query to the user's
        // own inventory ids. Otherwise the scanner returns all 1.5M
        // catalog rows numbered '108' (or whatever) and forces the
        // vendor to pick a card they don't even own — which then
        // bounces with "Not in your inventory." Pre-filtering at the
        // SQL layer turns the same scan into a tiny, fast match
        // against just what they have on shelf.
        //
        // Building the id set: collectionItems is already loaded in
        // memory. We collect api_card_id from rows that aren't ghosts
        // and aren't already-sold-offline. on_shelf_qty > 0 is the
        // ideal filter but we leave qty filtering to the downstream
        // _posSaleFromMatch handler so a vendor can see "out of
        // stock" matches and decide what to do.
        const _posIdSet = (window._posSaleMode && currentUser)
          ? new Set(
              (collectionItems || [])
                .filter(function(c) { return c && c.api_card_id && !c.is_ghost && !c.sold_offline; })
                .map(function(c) { return c.api_card_id; })
            )
          : null;
        const _posIdList = _posIdSet ? Array.from(_posIdSet) : null;
        if (_posIdList && _posIdList.length === 0) {
          if (!silent) setScanStatus('Your inventory is empty — add cards before POS scanning');
          return [];
        }
        const q = () => {
          let qb = sb.from('catalog')
            .select('id,name,set_name,set_code,card_number,rarity,image_url')
            .eq('game_type', scanTcg);
          if (isTopps) qb = qb.like('id', 'topps-%');
          // POS scope — only consider rows that exist in this user's
          // inventory. supabase-js .in() handles arrays of thousands
          // of ids in a single query.
          if (_posIdList) qb = qb.in('id', _posIdList);
          return qb;
        };

        // Derive a shorter base name for broader fallback searching:
        //   "Lugia VSTAR"            → "Lugia"
        //   "Reshiram & Charizard"   → "Reshiram"  (first partner only)
        //   "PikachuV"               → "Pikachu"   (no-space OCR variant)
        const SUFFIX_RE        = /\s+(VSTAR|VMAX|GX|EX|V|VUNION)$/i;
        // No-space suffix: OCR sometimes drops the space between the
        // Pokemon name and the V/VMAX/VSTAR/etc. marker, producing
        // "PikachuV" or "LugiaVSTAR". The standard catalog name has
        // the space, so the literal ilike on "PikachuV" returns 0 hits.
        // Strip the suffix in the same pattern.
        const SUFFIX_NOSPACE_RE = /([a-z])(VSTAR|VMAX|GX|EX|V|VUNION)$/;
        // Mega prefix no-space: XY-era M-cards print the M tight against
        // the Pokemon name ("MVenusaur EX", "MCharizard X"), so OCR
        // reads them without a space. Catalog stores "M Venusaur-EX"
        // with the space. Detecting the M+CapitalLetter pattern lets
        // us derive a queryable baseName "Venusaur" + run a name
        // variant with the space inserted.
        const MEGA_NOSPACE_RE = /^M([A-Z][a-z]+)/;
        let baseName = null;
        if (cardName) {
          if (SUFFIX_RE.test(cardName)) {
            baseName = cardName.replace(SUFFIX_RE, '').trim();
            // ALSO handle "MVenusaur EX" → "M Venusaur" → baseName
            // becomes the spaced form so it matches catalog "M Venusaur-EX".
            if (MEGA_NOSPACE_RE.test(baseName)) {
              baseName = baseName.replace(MEGA_NOSPACE_RE, 'M $1').trim();
            }
          } else if (SUFFIX_NOSPACE_RE.test(cardName)) {
            // "PikachuV" → "Pikachu"
            baseName = cardName.replace(SUFFIX_NOSPACE_RE, '$1').trim();
            if (MEGA_NOSPACE_RE.test(baseName)) {
              baseName = baseName.replace(MEGA_NOSPACE_RE, 'M $1').trim();
            }
          } else if (MEGA_NOSPACE_RE.test(cardName)) {
            // Bare "MVenusaur" without an EX/V/etc suffix — still split.
            baseName = cardName.replace(MEGA_NOSPACE_RE, 'M $1').trim();
          } else if (cardName.includes('&')) {
            // TAG TEAM: search by first partner name
            baseName = cardName.split('&')[0].trim();
          }
        }

        // Run all searches in parallel:
        // A: name + number   B: name + padded number
        // A2: baseName + number     B2: baseName + padded number
        //    (handles "Mega Pyroar ex" / "Lugia VSTAR" / TAG TEAMs where pokedata
        //    strips the suffix from `name` — search the stripped form too so
        //    name+number lands in the strong-score tier, not the weak fallback)
        // C: number only     D: padded number only
        // E: full name       F: base name (VSTAR/TAG suffix stripped)
        // G: set fingerprint RPC     H: set confirmation (which set_codes contain card #numTotal?)
        // I: expanded trainer name   J: Pokémon-only name from trainer card
        //    I+J handle trainer cards where OCR drops the 's (N'Zekrom → N's Zekrom → Zekrom)
        //    H is the set-size fingerprint: sv3pt5 has card #165, hgss4 doesn't
        // ── Scope the CLIP embedding search ──────────────────────────────
        // game_type filter eliminates cross-TCG noise (a Magic scan no
        // longer pulls Pokemon JP candidates into the top 10).
        // id-prefix filter narrows within Pokemon to the right language
        // bucket — when OCR detects Japanese text, we only want jp-/pd-
        // ids; when it's Chinese, only cn-; etc. EN OCR is permissive
        // (no prefix filter) because EN includes both `en-` rows and the
        // legacy bare-prefix rows from older syncs.
        const _scanPrefixes = (function() {
          if (ocrLang === 'JA') return ['jp-', 'pd-'];
          if (ocrLang === 'ZH') return ['cn-'];
          if (ocrLang === 'KO') return ['kr-'];
          return null; // EN — no prefix filter
        })();
        // For JP/ZH/KO OCR, lock TCG to pokemon (only Pokemon has
        // multi-language catalog coverage). Frontend already did this
        // for SQL queries; now apply the same to the embedding match.
        const _scanGameType = (ocrLang !== 'EN') ? 'pokemon' : scanTcg;
        // Try the v2 RPC first; fall back to the original match_cards
        // if the migration hasn't been applied yet. Threshold raised to
        // 0.18 (was 0.0) to cut bottom-of-the-barrel noise; count
        // dropped to 10 (was 15) since we don't need as many candidates
        // when the search is properly scoped.
        async function _runClipMatch() {
          const v2 = await sb.rpc('match_cards_v2', {
            query_embedding: fullEmbedding,
            match_threshold: 0.18,
            match_count:     10,
            p_game_type:     _scanGameType,
            p_id_prefixes:   _scanPrefixes,
          });
          if (!v2.error) return v2;
          // PGRST202 = function not found → fall through to v1.
          if (v2.error.code !== 'PGRST202' &&
              !(v2.error.message || '').includes('match_cards_v2')) {
            return v2; // genuine error — let caller surface it
          }
          console.warn('[Scanner] match_cards_v2 RPC not installed — falling back to unfiltered match_cards. Run migration_match_cards_v2.sql for sharper results.');
          return sb.rpc('match_cards', {
            query_embedding: fullEmbedding,
            match_threshold: 0.0,
            match_count:     15,
          });
        }

        // Build the set of card_number formats to match against. Catalog
        // rows from different sync paths store the number differently:
        // older sets use the bare form ('15' or '015'), newer pokedata
        // syncs store the full printed format ('015/086'). Without
        // covering both, modern cards never land in the name+number
        // tier and get out-scored by name-mismatch setTotal hits.
        const _cardNumVariants = (function() {
          var out = new Set();
          if (numStripped) out.add(numStripped);
          if (numRaw)      out.add(numRaw);
          if (numTotal) {
            if (numStripped) {
              out.add(numStripped + '/' + numTotal);
              // Also try padded total in case catalog stored it that way
              var paddedTotal = numTotal.length < 3 ? numTotal.padStart(3, '0') : numTotal;
              if (paddedTotal !== numTotal) out.add(numStripped + '/' + paddedTotal);
            }
            if (numRaw) {
              out.add(numRaw + '/' + numTotal);
              var paddedTotalB = numTotal.length < 3 ? numTotal.padStart(3, '0') : numTotal;
              if (paddedTotalB !== numTotal) out.add(numRaw + '/' + paddedTotalB);
            }
          }
          // SETCODE-NUMBER variants for OP / YGO catalogs. The OP sync
          // stores card_number as the FULL printed identifier:
          //   OP12-108, ST-19 has OP02-108, EB-02 has EB02-025
          // not just the trailing number. Without this entry, a clean
          // OCR of "OP12-108" still missed every catalog row because
          // we queried card_number = '108' which exists nowhere.
          // YGO uses the same shape ('RA05-EN085') and benefits too.
          if (parsedSetCode && numRaw) {
            out.add(parsedSetCode + '-' + numRaw);
            if (numStripped && numStripped !== numRaw) {
              out.add(parsedSetCode + '-' + numStripped);
            }
            // Zero-padded 3-digit form: 'OP12-108' is already padded, but
            // 'OP12-8' from a 1-digit number should also try 'OP12-008'.
            if (numStripped && numStripped.length < 3) {
              out.add(parsedSetCode + '-' + numStripped.padStart(3, '0'));
            }
            // SETCODE+NUMBER with NO separator — Pokemon Black Star
            // Promos store card_number as 'SWSH260', 'XY84', 'BW101'
            // glued together. Cover that storage layout too so the
            // num-only / name+num queries actually hit.
            out.add(parsedSetCode + numRaw);
            if (numStripped && numStripped !== numRaw) {
              out.add(parsedSetCode + numStripped);
            }
          }
          return Array.from(out);
        })();
        const _hasNumVariants = _cardNumVariants.length > 0;

        const [clipRes, nameNumRes, nameNumRawRes, baseNameNumRes, baseNameNumRawRes, numRes, numRawRes, nameRes, baseNameRes, setTotalRes, setConfirmRes, expandedRes, trainerPokemonRes, jpNumRes, ygoSetCodeRes] = await Promise.all([
          _runClipMatch(),
          // A — exact cardName + any card_number variant
          (_hasNumVariants && cardName)
            ? q().ilike('name', '%' + cardName + '%').in('card_number', _cardNumVariants).limit(8)
            : Promise.resolve({ data: [] }),
          // B — kept as a no-op placeholder; query A now covers all
          //     number variants in one round-trip via .in(...).
          Promise.resolve({ data: [] }),
          // A2 — baseName (suffix-stripped) + any card_number variant.
          //     Pokedata stores ex/V/VSTAR cards under the bare Pokémon
          //     name (catalog has "Mega Pyroar", card prints "Mega Pyroar
          //     ex"). Without this query the OCR'd name never matches a
          //     strong-tier row.
          (_hasNumVariants && baseName)
            ? q().ilike('name', '%' + baseName + '%').in('card_number', _cardNumVariants).limit(8)
            : Promise.resolve({ data: [] }),
          // B2 — placeholder; A2 now covers all variants.
          Promise.resolve({ data: [] }),
          // C — number only, any variant
          _hasNumVariants
            ? q().in('card_number', _cardNumVariants).limit(30)
            : Promise.resolve({ data: [] }),
          // D — placeholder; C now covers all variants.
          Promise.resolve({ data: [] }),
          // E
          cardName
            ? q().ilike('name', '%' + cardName + '%').limit(12)
            : Promise.resolve({ data: [] }),
          // F
          baseName
            ? q().ilike('name', '%' + baseName + '%').limit(12)
            : Promise.resolve({ data: [] }),
          // G — set fingerprint RPC (requires SQL function)
          (numStripped && numTotal)
            ? Promise.resolve(sb.rpc('match_card_in_set_by_total', { p_number: numStripped, p_total: numTotal })).catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] }),
          // H — client-side set confirmation: which set_codes contain a card numbered exactly numTotal?
          //     No extra SQL needed — query the existing catalog table directly.
          numTotal
            ? q().select('set_code').eq('card_number', numTotal).limit(100)
            : Promise.resolve({ data: [] }),
          // I — expanded trainer name: "N's Zekrom" (when OCR produced "N'Zekrom")
          expandedName
            ? q().ilike('name', '%' + expandedName + '%').limit(10)
            : Promise.resolve({ data: [] }),
          // J — Pokémon-only name from trainer card: "Zekrom" from "N's Zekrom"
          //     Broadest fallback — catches any version of this Pokémon across sets
          trainerPokemon
            ? q().ilike('name', '%' + trainerPokemon + '%').limit(12)
            : Promise.resolve({ data: [] }),
          // K — non-English: search the language-specific catalog by card number.
          //     JA → jp-/pd- prefixes (pokedata); ZH → cn-* (PriceCharting CN
          //     singles); KO → kr-* (PC KR singles). Without this scoping a
          //     Chinese card would falsely land on the JP branch via the
          //     legacy isJapaneseOcr() catch-all and miss its actual catalog
          //     rows entirely. Multiple number formats handle TCGdex variation
          //     across sets ('69', '069', '69/80', '069/080').
          (ocrLang !== 'EN' && numStripped)
            ? (() => {
                const numFmts = [numStripped];
                if (numRaw && numRaw !== numStripped) numFmts.push(numRaw);
                if (numTotal) { numFmts.push(numStripped + '/' + numTotal); if (numRaw) numFmts.push(numRaw + '/' + numTotal); }
                const orFilter = numFmts.filter((v,i,a) => a.indexOf(v) === i).map(n => 'card_number.eq.' + n).join(',');
                const prefixFilter = ocrLang === 'JA' ? 'id.like.jp-%,id.like.pd-%'
                                   : ocrLang === 'ZH' ? 'id.like.cn-%'
                                   : ocrLang === 'KO' ? 'id.like.kr-%'
                                   : '';
                return q().or(prefixFilter).or(orFilter).limit(30).then(r => r || { data: [] }).catch(() => ({ data: [] }));
              })()
            : Promise.resolve({ data: [] }),
          // L — Set-coded number lookup. Triggered when OCR captured a
          //     SETCODE-NUMBER pattern: YGO (RA05-EN085) or One Piece
          //     (OP06-093 / ST01-001 / EB01-001). Catalog rows store
          //     set_code='OP06' (etc.) and card_number='093'. Without
          //     this query, OP scans had no path from setCode to the
          //     right row — the slash fraction parser doesn't match
          //     OP's dash format, so name-only hits returned a dozen
          //     Peronas across sets with no way to disambiguate.
          //     YGO set codes can include a trailing letter ("045b") that
          //     gets folded into the padded form via numRaw.
          ((scanTcg === 'yugioh' || scanTcg === 'onepiece' || scanTcg === 'gundam') && parsedSetCode && numStripped)
            ? (() => {
                // Reuse the full _cardNumVariants set so this query covers
                // both bare-number storage ('108') AND full SETCODE-NUMBER
                // storage ('OP12-108'). The OP catalog uses the latter.
                return q().eq('set_code', parsedSetCode).in('card_number', _cardNumVariants).limit(10)
                  .then(r => r || { data: [] }).catch(() => ({ data: [] }));
              })()
            : Promise.resolve({ data: [] })
        ]);

        if (clipRes.error) {
          if (clipRes.error.code === 'PGRST202' || (clipRes.error.message && clipRes.error.message.includes('match_cards'))) {
            if (!silent) setScanStatus('Run scanner_setup.sql in Supabase first');
            return [];
          } else throw clipRes.error;
        }

        let   clipMatches    = clipRes.data         || [];
        // POS mode: strip CLIP candidates that aren't in the user's
        // inventory. The RPC doesn't take an id-filter param, so we
        // filter client-side. Same goal as the q() scoping above —
        // the scanner should only ever surface cards the vendor
        // actually has on shelf.
        if (_posIdSet) {
          clipMatches = clipMatches.filter(function(m) { return m && _posIdSet.has(m.id); });
        }
        // The setTotal RPC (match_card_in_set_by_total) doesn't take a
        // game_type filter, so it returns matches across ALL TCGs.
        // That was the bug behind "Pikachu V scan returned Forbidden
        // Alchemy at the top": a Magic card numbered 86 hit with score
        // 1.15 and outranked the Pokemon name hits.
        //
        // Fix: re-verify the RPC's IDs against catalog scoped to the
        // detected TCG. One extra round-trip but small (5-30 IDs),
        // and it gives us back the game-correct rows. For non-EN OCR
        // we force pokemon (only Pokemon has multi-language coverage).
        const _effectiveTcg = (ocrLang !== 'EN') ? 'pokemon' : scanTcg;
        const _rawSetTotal  = setTotalRes.data || [];
        let setTotalHits = [];
        if (_rawSetTotal.length > 0) {
          // POS mode: pre-filter against inventory ids BEFORE the verify
          // round-trip so Postgres only has to look up rows the user
          // actually owns. Without this scope, setTotalHits leaked the
          // entire catalog's matches for cards numbered N in a set of
          // size T — Forretress / Exploud / Caterpie / Victreebel
          // surfaced in POS results even though the vendor had none
          // of them in stock.
          let _ids = _rawSetTotal.map(function(h){ return h.id; });
          if (_posIdSet) _ids = _ids.filter(function(id){ return _posIdSet.has(id); });
          if (_ids.length > 0) {
            const verifyRes = await sb.from('catalog')
              .select('id,name,set_name,set_code,card_number,rarity,image_url')
              .in('id', _ids)
              .eq('game_type', _effectiveTcg);
            setTotalHits = verifyRes.data || [];
          }
        }
        const nameNumHits    = [
          ...(nameNumRes.data       || []),
          ...(nameNumRawRes.data    || []),
          ...(baseNameNumRes.data   || []),  // A2: baseName + number
          ...(baseNameNumRawRes.data|| []),  // B2: baseName + padded number
        ];
        const numHits        = [...(numRes.data || []), ...(numRawRes.data || [])];
        const nameHits       = [...(nameRes.data || []), ...(baseNameRes.data || [])];
        const expandedHits   = expandedRes.data     || [];  // trainer name expanded (N's Zekrom)
        const trainerPokHits = trainerPokemonRes.data || []; // Pokémon name only (Zekrom)
        const jpNumHits      = (jpNumRes && jpNumRes.data) || [];  // JP catalog by card number
        // L — YGO set-coded number lookup (RA05-EN085 → set_code='RA05' + card_number='085')
        const ygoSetHits     = (ygoSetCodeRes && ygoSetCodeRes.data) || [];

        // H — set_codes that contain a card numbered exactly numTotal (e.g. '165')
        // These are confirmed to be the right-sized set for this card's numbering system.
        const confirmedSets = new Set((setConfirmRes.data || []).map(function(r){ return r.set_code; }));

        console.log('[Scanner] set-fingerprint hits (best):', setTotalHits.map(function(m){return m.name+' '+m.set_code;}).join(', ') || 'none');
        console.log('[Scanner] name+num hits:', nameNumHits.map(function(m){return m.name+'/'+m.set_code;}).join(', '));
        console.log('[Scanner] num-only hits:', numHits.length, '| name-only hits:', nameHits.length);
        console.log('[Scanner] expanded/trainer hits:', expandedHits.map(function(m){return m.name+'/'+m.set_code;}).join(', ') || 'none');
        console.log('[Scanner] lang-scoped num hits ('+ocrLang+'):', jpNumHits.map(function(m){return m.name+'/'+m.set_code+'/cn:'+m.card_number;}).join(', ') || 'none');
        console.log('[Scanner] confirmed sets (contain card #'+numTotal+'):', [...confirmedSets].join(', ') || 'none');
        console.log('[Scanner] CLIP top3:', clipMatches.slice(0,3).map(function(m){return m.name+'('+(m.similarity*100).toFixed(0)+'%)';}).join(' '));

        // Scoring tiers (higher = more confident match):
        //   1.30  JP num + set confirmed (jp- id, correct number, set has right total) [JP OCR mode]
        //   1.30  nameNum + set confirmed by size fingerprint  (was 1.22 — was being out-scored
        //                                                       by name-mismatch setTotal hits)
        //   1.20  exact-name-match bonus is layered on top of the above tiers
        //   1.15  setTotal RPC                                 (number + RPC set fingerprint)
        //   1.10  JP num (jp- id, correct number, no set confirm) [JP OCR mode]
        //   1.05  expanded trainer name match                  (N's Zekrom)
        //   1.00  name + number match
        //   0.88  number only
        //   0.80  Pokémon name from trainer card               (broadest — Zekrom)
        //   0.78  name only / base name
        //
        // When JP OCR is detected, all non-jp-/pd- cards are penalised by −0.35 so
        // any jp-/pd- number match wins over English-only hits.
        // CLIP similarity bumped to ×0.20 (was 0.12) for EN and ×0.35 (was 0.27) for
        // language-matched, so a strong visual confirmation (>70%) decisively breaks ties.
        // Exact-name-match bonus (+0.20) separates "Mega Pyroar" from "Mega Pyroar ex"
        // when both are returned from an ilike substring search.
        var _cardNameLc = cardName ? cardName.toLowerCase() : '';
        var _baseNameLc = baseName ? baseName.toLowerCase() : '';
        function scoreOcr(m, source) {
          // Derive the catalog row's language from its id prefix:
          //   jp-/pd-  → JA   |  cn-* → ZH   |  kr-* → KO   |  en-/raw → EN
          var cardLang = !m.id                    ? 'EN'
                       : m.id.startsWith('jp-')   ? 'JA'
                       : m.id.startsWith('pd-')   ? 'JA'
                       : m.id.startsWith('cn-')   ? 'ZH'
                       : m.id.startsWith('kr-')   ? 'KO'
                       :                            'EN';
          var langMatch    = (ocrLang !== 'EN' && cardLang === ocrLang);
          var langMismatch = (ocrLang !== 'EN' && cardLang !== ocrLang);
          var base = source === 'setTotal'   ? 1.15
                   : source === 'nameNum'    ? 1.0
                   : source === 'expanded'   ? 1.05
                   : source === 'trainerPok' ? 0.80
                   : source === 'jpNum'      ? (numTotal && confirmedSets.has(m.set_code) ? 1.30 : 1.10)
                   : source === 'num'        ? 0.88
                   :                          0.78;
          // +0.30 when name+number match AND the card's set contains card #numTotal
          // (bumped from 0.22 so name+num+setConfirm decisively beats name-mismatch
          // setTotal hits at 1.15).
          var setConfirmedBoost = (source === 'nameNum' && numTotal && confirmedSets.has(m.set_code)) ? 0.30 : 0;
          // Exact-name-match bonus — separates the actual card from
          // accidental substring matches. cardName "Mega Pyroar ex" vs
          // catalog rows "Mega Pyroar" + "Mega Pyroar ex" — the exact
          // one gets +0.20.
          //
          // Symmetric stripping: OCR can capture the base form without
          // the "ex"/"V"/"VMAX" suffix (e.g. Pokemon Center MEP promos
          // overlap the small "ex" with the big "X" so OCR reads
          // "Mega Charizard X" while catalog has "Mega Charizard X ex").
          // We compare BOTH directions — OCR side stripped (existing
          // baseName) AND catalog side stripped — so a near-match
          // still wins the bonus and rises above the un-named tied
          // pile of name-only hits.
          var nameLc = (m.name || '').toLowerCase();
          // Strip "-EX" / " EX" / "-GX" / " V" / etc. Pokedata catalogs
          // are inconsistent: XY-era ex cards use a HYPHEN ("M Slowbro-EX",
          // "Mewtwo-EX"), Sword & Shield V uses a space ("Pikachu V"),
          // SV uses lowercase ex with a space ("Charizard ex"). All
          // three need to collapse to the same base name for the
          // exact-name bonus to fire against the OCR cardName, which
          // never has the suffix (OCR clips "ex" off the corner).
          var nameStripped = nameLc
            .replace(/[\s-]+(ex|gx|v|vmax|vstar|tag\s*team|tag-team|prime|crystal|legend)$/i, '')
            .trim();
          var exactNameBonus = 0;
          if (nameLc && (
                nameLc       === _cardNameLc ||
                nameLc       === _baseNameLc ||
                nameStripped === _cardNameLc ||
                nameStripped === _baseNameLc
             )) {
            exactNameBonus = 0.20;
          }
          var clipEntry = clipMatches.find(function(c){ return c.id === m.id; });
          // Boost CLIP similarity when the card's language matches the OCR.
          // Multipliers bumped (0.12 → 0.20, 0.27 → 0.35) so a strong
          // visual match (>70%) carries real weight even against the
          // catalog scoring tiers.
          var clipMult = langMatch ? 0.35 : 0.20;
          var clipBoost = clipEntry ? clipEntry.similarity * clipMult : 0;
          // Penalise wrong-language cards so language-matched hits always win
          var langPenalty = langMismatch ? 0.35 : 0;
          return base + setConfirmedBoost + exactNameBonus + clipBoost - langPenalty;
        }

        let   merged = [];
        const seen   = new Set();
        function addHits(hits, source) {
          hits.forEach(function(m) {
            if (seen.has(m.id)) return;
            // Drop rows with NULL / blank name — older syncs (some JP
            // pokedata mirrors, partial PC enrich runs) created catalog
            // rows where the name column never got populated. Those
            // surface in the UI as "Unknown Card · #22" and clutter
            // the results sheet without giving the user anything they
            // could act on. They're a data-cleanup task, not a
            // scanner problem; we just filter them out at render time.
            if (!m.name || !String(m.name).trim()) return;
            merged.push(Object.assign({}, m, { similarity: scoreOcr(m, source), _ocr: true }));
            seen.add(m.id);
          });
        }
        addHits(setTotalHits,   'setTotal');    // number + RPC set fingerprint
        addHits(nameNumHits,    'nameNum');      // name + number (+ set-confirm boost)
        addHits(jpNumHits,      'jpNum');        // JP catalog: jp- cards by card number
        addHits(expandedHits,   'expanded');     // trainer name expansion (N's Zekrom)
        addHits(numHits,        'num');          // number only
        addHits(nameHits,       'name');         // full name / base name
        addHits(trainerPokHits, 'trainerPok');  // Pokémon name from trainer card
        // CLIP-only candidates. If the visual match's catalog name
        // exactly matches the OCR'd card name (or base name), promote
        // it to an OCR-anchored 'name' hit so it picks up the
        // exact-name bonus + CLIP multiplier. This rescues catalog-
        // coverage gaps: when the user's specific JP printing isn't
        // in catalog but CLIP confidently identifies the Pokemon, the
        // scanner now surfaces a same-Pokemon match (wrong set) at
        // the top instead of a random card that just shares the
        // card number. Threshold 0.75 keeps weak visual matches from
        // hijacking the result.
        clipMatches.forEach(function(m) {
          if (seen.has(m.id)) return;
          // Same null-name filter as addHits — visual-only candidates
          // with empty name fields shouldn't display either.
          if (!m.name || !String(m.name).trim()) return;
          var rn = (m.name || '').toLowerCase();
          var nameMatch = rn && (rn === _cardNameLc || rn === _baseNameLc);
          if (nameMatch && (m.similarity || 0) >= 0.75) {
            merged.push(Object.assign({}, m, { similarity: scoreOcr(m, 'name'), _ocr: true }));
          } else {
            merged.push(m);
          }
          seen.add(m.id);
        });
        // Final POS inventory guard. Every query path SHOULD have
        // already filtered through q() or applied _posIdSet manually
        // (setTotalHits verify, clipMatches filter). This is a
        // belt-and-suspenders pass so any future query addition can't
        // silently leak non-inventory cards into the results.
        if (_posIdSet) {
          merged = merged.filter(function(m) { return m && m.id && _posIdSet.has(m.id); });
        }
        merged.sort(function(a, b) { return b.similarity - a.similarity; });

        // Collapse near-duplicates that survived addHits' id-based seen
        // set. Different upstream syncs store the same physical card with
        // different card_number padding ("98" vs "098") or slightly
        // different ids (pokedata "swsh1-25" vs PriceCharting
        // "en-pc-12345"), so the merged list ends up with two rows for
        // the same Doublade. We collapse on
        //   (lower(set_code), lower(name), card_number with leading zeros stripped)
        // and keep the first (highest-scored) survivor. Catalog cleanup
        // is the proper fix; this stops the bleeding in the UI.
        var _dedupSeen = new Set();
        merged = merged.filter(function(m) {
          var sc = (m.set_code || '').toLowerCase();
          var nm = (m.name     || '').toLowerCase().trim();
          var cn = String(m.card_number || '').replace(/^0+/, '') || '0';
          var k  = sc + '||' + nm + '||' + cn;
          if (_dedupSeen.has(k)) return false;
          _dedupSeen.add(k);
          return true;
        });

        // Second pass — drop "Miscellaneous Promos" / generic PC bucket
        // duplicates when the same name + card_number lives in a real
        // set. PriceCharting dumps Cosmos Holo / pre-release / staff
        // variants into a "Miscellaneous Promos" pseudo-set; those
        // surface as a confusing dupe of the canonical printing (e.g.
        // Gengar BREAKthrough #60 vs Gengar "Miscellaneous Promos" #60
        // — both are the same Gengar art, different upstream catalog).
        // If a non-misc counterpart exists, the misc row is dropped.
        // If ALL matches are misc-bucket, none are dropped (the user
        // genuinely scanned a promo-only card).
        var _GENERIC_SET = /miscellaneous|other\s*promo|^promo\s*$/i;
        var _byNameNum = new Map();
        merged.forEach(function(m) {
          var nm = (m.name || '').toLowerCase().trim();
          var cn = String(m.card_number || '').replace(/^0+/, '') || '0';
          if (!nm) return;
          var k = nm + '||' + cn;
          if (!_byNameNum.has(k)) _byNameNum.set(k, []);
          _byNameNum.get(k).push(m);
        });
        var _dropIds = new Set();
        _byNameNum.forEach(function(rows) {
          if (rows.length < 2) return;
          var hasReal = rows.some(function(r) { return !_GENERIC_SET.test(r.set_name || ''); });
          if (!hasReal) return;
          rows.forEach(function(r) {
            if (_GENERIC_SET.test(r.set_name || '')) _dropIds.add(r.id);
          });
        });
        if (_dropIds.size) {
          merged = merged.filter(function(m) { return !_dropIds.has(m.id); });
        }

        // When OCR read a card name, drop any CLIP-only candidate whose
        // catalog name doesn't share a token with the parsed name (or
        // the suffix-stripped baseName). Catalog-hit rows (anything with
        // _ocr set — name+num, num-only, expanded, trainer, jpNum, etc.)
        // came from an actual OCR signal so they always stay; this only
        // trims the visual-match cards that have no textual confirmation,
        // which is where the scanner was surfacing unrelated cards
        // (Drilbur/Cresselia/Naganadel etc. when the OCR clearly said
        // "Houndoom" or "Clefairy").
        let filtered = merged;
        if (cardName) {
          const nameLcF  = cardName.toLowerCase();
          const baseLcF  = (baseName || '').toLowerCase();
          // Token overlap rather than substring: "Mega Pyroar ex" tokens
          // ['mega','pyroar','ex'] overlap with catalog 'Pyroar' on
          // 'pyroar'. Strips common short tokens that match too easily.
          const STOP = new Set(['ex','v','vmax','vstar','gx','de','the','of','and','&']);
          const tokenize = function(s) {
            return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
          };
          const queryTokens = tokenize(nameLcF + ' ' + baseLcF).filter(function(t) {
            return t.length >= 3 && !STOP.has(t);
          });
          if (queryTokens.length) {
            // Yu-Gi-Oh + MTG token scans frequently produce OCR names that
            // *look* like the card title but are noisy enough that strict
            // token overlap throws away high-confidence CLIP matches —
            // e.g. CLIP says "Laserbeak" at 0.93 but OCR mis-read it as
            // "LASERBE AK" so the cleaned token doesn't overlap. For those
            // TCGs we relax the filter: any CLIP candidate ≥ 0.90 stays
            // even without OCR confirmation.
            const relaxClipFloor = (typeof scanTcg !== 'undefined' && scanTcg !== 'pokemon') ? 0.90 : Infinity;
            filtered = merged.filter(function(m) {
              if (m._ocr) return true;  // came from an OCR-anchored query
              if ((m.similarity || 0) >= relaxClipFloor) return true; // high-confidence CLIP
              const rn = (m.name || '').toLowerCase();
              if (!rn) return false;
              // Keep if any meaningful query token appears in the
              // candidate's name OR vice-versa.
              for (let qi = 0; qi < queryTokens.length; qi++) {
                if (rn.indexOf(queryTokens[qi]) !== -1) return true;
              }
              return false;
            });
          }
          if (filtered.length === 0) filtered = merged; // never strand the user
        }
        let final = filtered.slice(0, 10);

        // POS-mode product/sealed fallback. If card-scan returned no
        // matches and we're in POS mode, fall through to OCR-text
        // scoring against the user's in-memory inventory. The card
        // pipeline's queries are shaped around TCG card layout
        // (game_type, card_number, set_code) and a booster box / ETB
        // / Funko OCR doesn't fit that mold — but the user's
        // collection_items already have card_name and set_name
        // populated for every product they sell, so we can score
        // them client-side by token overlap with the OCR text.
        // Reuses the existing scan-results UI and the existing
        // _posSaleFromMatch routing — no new modal, no schema
        // changes, no new dependencies.
        if (final.length === 0 && window._posSaleMode && _posIdSet) {
          final = _posInventoryFallback(fullText, cardName);
        }

        if (!silent) {
          // Reveal name search fallback now that scan is complete
          const _fallback = document.getElementById('scannerSearchFallback');
          if (_fallback) _fallback.style.display = '';
          if (final.length === 0) {
            const countRes = await sb.from('catalog').select('id', { count: 'exact', head: true }).not('embedding', 'is', null);
            const embeddedCount = countRes.count || 0;
            if (embeddedCount === 0) {
              const totalRes = await sb.from('catalog').select('id', { count: 'exact', head: true });
              const totalCount = totalRes.count || 0;
              if (totalCount === 0) {
                setScanStatus('Card catalog is empty — run generate_embeddings.py first');
              } else {
                setScanStatus(`Catalog blocked (${totalCount.toLocaleString()} cards exist but can't be read) — run: alter table catalog disable row level security`);
              }
            } else {
              setScanStatus('No match found — try a clearer photo or use the name search below');
            }
          } else {
            const top = final[0];
            const src = top._exact ? 'EXACT' : (top._ocr ? 'OCR' : (Math.round(top.similarity * 100) + '% visual'));
            setScanStatus('Best match: ' + top.name + ' (' + src + ') — tap card to preview');
            showScanResults(final);
          }
        }
        return final;
      } catch(err) {
        console.error('[Scanner]', err);
        if (!silent) setScanStatus('Error: ' + (err.message || err));
        return [];
      } finally {
        // nothing to re-enable — sheet stays open
      }
    }

    // ── MULTI-SCAN (vendor+) ───────────────────────────────────────────────────
    let _multiScanResults = [];
    let _msSpreadDataURL  = null;

    function openMultiScan() {
      if (!currentUser) { showToast('Sign in to use multi-scan'); return; }
      // Collector+ can access bulk scan (vendor is collector+)
      if (!tierAtLeast('collector')) { openPricingModalWithPromo('collector'); return; }

      // Monthly bulk-session gate
      const bulkUsed  = getUsageCount('bulk');
      const bulkLimit = bulkSessionLimit();
      if (bulkUsed >= bulkLimit) {
        const nextTier = tierAtLeast('enthusiast') ? null : 'enthusiast';
        if (nextTier) {
          showToast('Monthly bulk scan limit reached (' + bulkLimit + '). Upgrading unlocks more.');
          setTimeout(() => openPricingModalWithPromo(nextTier), 600);
        } else {
          // Vendor at their limit — contact us
          showToast('Monthly bulk limit reached (' + bulkLimit + '). Contact us to move to Shop.');
          setTimeout(() => { openPricingModal(); setTimeout(openShopIntake, 300); }, 600);
        }
        return;
      }
      _multiScanResults = [];
      _msSpreadDataURL  = null;
      // Reset to picker view
      document.getElementById('msPickerView').style.display   = 'block';
      document.getElementById('msSpreadPicker').style.display = 'none';
      document.getElementById('msProgressView').style.display = 'none';
      document.getElementById('msReviewView').style.display   = 'none';
      document.getElementById('msFooter').style.display       = 'none';
      document.getElementById('msMultiInput').value   = '';
      document.getElementById('msSpreadInput').value  = '';
      openModal('multiScanModal');
    }

    // Utility: read a File (or {_dataURL}) as a dataURL
    function readFileAsDataURL(file) {
      if (file._dataURL) return Promise.resolve(file._dataURL);
      return new Promise(function(resolve, reject) {
        var r = new FileReader();
        r.onload  = function(e) { resolve(e.target.result); };
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }

    // Crop an image dataURL into rows*cols sub-images using canvas
    function cropImageGrid(dataURL, rows, cols) {
      return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
          var cw = Math.floor(img.width  / cols);
          var ch = Math.floor(img.height / rows);
          var crops = [];
          for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
              var cv = document.createElement('canvas');
              cv.width = cw; cv.height = ch;
              cv.getContext('2d').drawImage(img, c*cw, r*ch, cw, ch, 0, 0, cw, ch);
              crops.push(cv.toDataURL('image/jpeg', 0.88));
            }
          }
          resolve(crops);
        };
        img.src = dataURL;
      });
    }

    // Called when user picks one spread photo — show grid size picker
    async function handleSpreadScanFile(file) {
      if (!file) return;
      _msSpreadDataURL = await readFileAsDataURL(file);
      var thumb = document.getElementById('msSpreadThumb');
      if (thumb) { thumb.src = _msSpreadDataURL; thumb.style.display = 'block'; }
      document.getElementById('msPickerView').style.display   = 'none';
      document.getElementById('msSpreadPicker').style.display = 'block';
    }

    // Called by grid size buttons in spread picker
    async function processSpreadGrid(rows, cols) {
      if (!_msSpreadDataURL) return;
      // Hard cap: max 3×3 grid to keep OCR reliable
      if (rows > 3 || cols > 3) { showToast('Max grid size is 3 × 3'); return; }
      var crops = await cropImageGrid(_msSpreadDataURL, rows, cols);
      startMultiScanProcessing(crops);
    }

    // Called when user picks multiple photos
    async function handleMultiScanFiles(fileList) {
      if (!fileList || fileList.length === 0) return;
      // Per-session card cap based on tier
      var sessionCap = bulkCardsPerSession();
      if (fileList.length > sessionCap) {
        showToast('Your plan allows up to ' + sessionCap + ' cards per bulk scan session.');
        return;
      }
      // Absolute safety cap (no one should need more than 100 individual photos at once)
      if (fileList.length > 100) { showToast('Max 100 images at once'); return; }
      var dataURLs = await Promise.all(Array.from(fileList).map(readFileAsDataURL));
      startMultiScanProcessing(dataURLs);
    }

    // Core processing loop — receives array of dataURL strings
    async function startMultiScanProcessing(dataURLs) {
      // Count this as one bulk session
      incrementUsage('bulk');
      _multiScanResults = dataURLs.map(function(url) {
        return { thumb: url, status: 'pending', matches: [], included: true, selectedMatch: null };
      });

      // Switch to progress view
      document.getElementById('msPickerView').style.display   = 'none';
      document.getElementById('msSpreadPicker').style.display = 'none';
      document.getElementById('msProgressView').style.display = 'block';

      var listEl = document.getElementById('msProgressList');
      listEl.innerHTML = _multiScanResults.map(function(r, i) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">'
          + '<img src="' + r.thumb + '" style="width:30px;height:42px;object-fit:cover;border-radius:2px;border:1px solid var(--border);flex-shrink:0" loading="lazy" decoding="async">'
          + '<span id="msprog-s-' + i + '" style="font-size:.72rem;color:var(--muted)">Waiting…</span>'
          + '</div>';
      }).join('');

      // Process in batches of 3 to avoid GCV rate limits
      var done = 0;
      for (var i = 0; i < dataURLs.length; i += 3) {
        var batch = dataURLs.slice(i, i + 3);
        // Mark as scanning
        batch.forEach(function(_, j) {
          var el = document.getElementById('msprog-s-' + (i+j));
          if (el) el.textContent = 'Scanning…';
        });
        var batchMatches = await Promise.all(
          batch.map(function(url) { return runMatch(url, { silent: true }).catch(function() { return []; }); })
        );
        batchMatches.forEach(function(matches, j) {
          var idx = i + j;
          _multiScanResults[idx].matches       = matches || [];
          _multiScanResults[idx].selectedMatch = (matches && matches.length > 0) ? matches[0] : null;
          _multiScanResults[idx].status        = 'done';
          // Each photo is a real scan — runMatch was called with silent=true
          // so its internal scanner-badge increment was skipped. Tally it
          // here so the SCANNER.EXE badge progresses through multi-scan too.
          try { checkBadge_scanner(); } catch(_) {}
          done++;
          var pct = Math.round(done / dataURLs.length * 100);
          document.getElementById('msProgressBar').style.width   = pct + '%';
          document.getElementById('msProgressStatus').textContent = 'Processing ' + done + ' of ' + dataURLs.length + '…';
          var el = document.getElementById('msprog-s-' + idx);
          if (el) el.textContent = matches && matches.length > 0 ? '✓ ' + matches[0].name : '— no match';
        });
      }
      renderMultiScanReview();
    }

    // ── Candidate sheet — slides over the review list when user taps a card row ──
    var _msSheetIdx = null;   // which card is currently open in the sheet
    var _msSheetDebounce = null;

    function openMsCandidateSheet(idx) {
      _msSheetIdx = idx;
      var r   = _multiScanResults[idx];
      var sheet = document.getElementById('msCandidateSheet');
      if (!sheet) return;

      // Show scan thumbnail
      var thumb = document.getElementById('msSheetThumb');
      if (thumb) { thumb.src = r.thumb; }

      // Header label
      var label = document.getElementById('msSheetLabel');
      if (label) label.textContent = r.selectedMatch ? 'Wrong card? Pick the right one:' : 'No match found — search for this card:';

      // Pre-fill search with current match name (if any)
      var searchEl = document.getElementById('msSheetSearch');
      if (searchEl) { searchEl.value = r.selectedMatch ? r.selectedMatch.name : ''; }

      // Populate candidate list from scan results
      renderMsSheetList(idx);

      sheet.style.display = 'flex';

      // Focus the search input so keyboard is ready
      if (searchEl) setTimeout(function() { searchEl.focus(); }, 80);
    }

    function closeMsCandidateSheet() {
      var sheet = document.getElementById('msCandidateSheet');
      if (sheet) sheet.style.display = 'none';
      _msSheetIdx = null;
      clearTimeout(_msSheetDebounce);
    }

    function renderMsSheetList(idx) {
      var r    = _multiScanResults[idx];
      var list = document.getElementById('msSheetList');
      if (!list) return;

      if (!r.matches || r.matches.length === 0) {
        list.innerHTML = '<div style="font-size:.72rem;color:var(--muted);padding:10px 4px">No scanner results — use the search below.</div>';
        return;
      }

      var selectedId = r.selectedMatch ? r.selectedMatch.id : null;
      list.innerHTML = r.matches.map(function(m, mi) {
        var conf  = m._exact ? 'EXACT' : m._ocr ? 'OCR' : Math.round((m.similarity||0)*100) + '% visual';
        var isSel = m.id === selectedId;
        return '<div onclick="confirmMsSheetPick(' + idx + ',' + mi + ',\'scan\')" '
          + 'style="display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;border-radius:5px;margin-bottom:2px;'
          + (isSel ? 'background:var(--surface2);outline:1.5px solid var(--accent2);' : 'background:transparent;')
          + '">'
          + (m.image_url
            ? '<img src="' + m.image_url + '" style="width:36px;height:50px;object-fit:cover;border-radius:3px;flex-shrink:0" onerror="this.style.display=\'none\'" loading="lazy" decoding="async">'
            : '<div style="width:36px;height:50px;background:var(--surface2);border-radius:3px;flex-shrink:0"></div>')
          + '<div style="flex:1;min-width:0">'
          + '<div style="font-size:.8rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.name + '</div>'
          + '<div style="font-size:.65rem;color:var(--muted)">' + (m.set_name||m.set_code||'') + ' · #' + (m.card_number||'?') + '</div>'
          + '<div style="font-size:.62rem;color:var(--accent2)">' + conf + '</div>'
          + '</div>'
          + (isSel ? '<span style="color:var(--accent2);font-size:1rem;flex-shrink:0">✓</span>' : '')
          + '</div>';
      }).join('');
    }

    // Called when user types in the sheet's search input
    function debounceMsSheetSearch(query) {
      clearTimeout(_msSheetDebounce);
      _msSheetDebounce = setTimeout(function() { runMsSheetSearch(query); }, 300);
    }

    async function runMsSheetSearch(query) {
      if (_msSheetIdx === null) return;
      var searchRes = document.getElementById('msSheetSearchResults');
      if (!searchRes) return;
      query = (query || '').trim();
      if (query.length < 2) { searchRes.innerHTML = ''; return; }

      searchRes.innerHTML = '<div style="font-size:.68rem;color:var(--muted);padding:6px 0">Searching…</div>';

      // ── Parse query for name and/or number components ────────────────────
      // Handles: "Gengar", "94", "094/165", "Gengar 94", "Gengar 094/165"
      var parsedName = null, parsedNum = null;
      // Strip set-fraction suffix if present (e.g. "094/165" → "094")
      var numPattern = /\b(\d{1,3})(?:\/\d+)?\b/;
      var numMatch   = query.match(numPattern);
      if (numMatch) {
        parsedNum  = numMatch[1].replace(/^0+/, '') || '0'; // "094" → "94"
        // Everything that isn't the number token is the name
        var withoutNum = query.replace(numMatch[0], '').trim();
        if (withoutNum.length >= 2) parsedName = withoutNum;
      } else {
        parsedName = query;
      }

      // Build parallel queries: name+num (highest priority), name-only, num-only
      var q = function() {
        return sb.from('catalog').select('id,name,set_name,set_code,card_number,rarity,image_url');
      };
      var promises = [];
      var sources  = []; // 'both' | 'name' | 'num'

      if (parsedName && parsedNum) {
        promises.push(q().ilike('name', '%' + parsedName + '%').eq('card_number', parsedNum).limit(8));
        sources.push('both');
      }
      if (parsedName) {
        promises.push(q().ilike('name', '%' + parsedName + '%').limit(10));
        sources.push('name');
      }
      if (parsedNum) {
        promises.push(q().eq('card_number', parsedNum).limit(10));
        sources.push('num');
      }

      var allResults = await Promise.all(promises);

      // Merge & deduplicate — name+num results float to the top
      var seen = {};
      var results = [];
      allResults.forEach(function(res, si) {
        (res.data || []).forEach(function(row) {
          if (!seen[row.id]) {
            seen[row.id] = true;
            // Give name+num matches priority (source 'both')
            if (sources[si] === 'both') results.unshift(row);
            else results.push(row);
          }
        });
      });
      results = results.slice(0, 12); // cap at 12

      var idx     = _msSheetIdx;
      _multiScanResults[idx]._searchResults = results;

      if (results.length === 0) {
        searchRes.innerHTML = '<div style="font-size:.68rem;color:var(--muted);padding:6px 0">No results for "' + query + '"</div>';
      } else {
        var selectedId = _multiScanResults[idx].selectedMatch ? _multiScanResults[idx].selectedMatch.id : null;
        searchRes.innerHTML = results.map(function(m, mi) {
          var isSel = m.id === selectedId;
          return '<div onclick="confirmMsSheetPick(' + idx + ',' + mi + ',\'search\')" '
            + 'style="display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;border-radius:5px;margin-bottom:2px;'
            + (isSel ? 'background:var(--surface2);outline:1.5px solid var(--accent2);' : 'background:transparent;')
            + '">'
            + (m.image_url
              ? '<img src="' + m.image_url + '" style="width:36px;height:50px;object-fit:cover;border-radius:3px;flex-shrink:0" onerror="this.style.display=\'none\'" loading="lazy" decoding="async">'
              : '<div style="width:36px;height:50px;background:var(--surface2);border-radius:3px;flex-shrink:0"></div>')
            + '<div style="flex:1;min-width:0">'
            + '<div style="font-size:.8rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.name + '</div>'
            + '<div style="font-size:.65rem;color:var(--muted)">' + (m.set_name||m.set_code||'') + ' · #' + (m.card_number||'?') + '</div>'
            + '</div>'
            + (isSel ? '<span style="color:var(--accent2);font-size:1rem;flex-shrink:0">✓</span>' : '')
            + '</div>';
        }).join('');
      }
    }

    // User tapped a candidate — set it and close the sheet
    function confirmMsSheetPick(cardIdx, matchIdx, source) {
      var r    = _multiScanResults[cardIdx];
      var list = source === 'search' ? r._searchResults : r.matches;
      if (!list || matchIdx >= list.length) return;
      r.selectedMatch = list[matchIdx];
      r.included      = true;
      closeMsCandidateSheet();
      renderMultiScanReview();   // re-render review with updated selection
    }

    function renderMultiScanReview() {
      var container = document.getElementById('msReviewView');
      var matched   = _multiScanResults.filter(function(r) { return r.selectedMatch; });

      var rows = _multiScanResults.map(function(r, i) {
        var m         = r.selectedMatch;
        var thumbHTML = '<img src="' + r.thumb + '" style="width:42px;height:58px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0" loading="lazy" decoding="async">';

        if (!m) {
          // No match — tap row to open candidate sheet (search mode)
          return '<div onclick="openMsCandidateSheet(' + i + ')" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer">'
            + thumbHTML
            + '<div style="flex:1;min-width:0">'
            + '<div style="font-size:.75rem;color:var(--muted)">No match found</div>'
            + '<div style="font-size:.65rem;color:var(--accent2);margin-top:2px">Tap to search →</div>'
            + '</div>'
            + '<span style="color:var(--muted);font-size:.9rem;flex-shrink:0">›</span>'
            + '</div>';
        }

        // Matched card — show result, tap to change
        var conf = m._exact ? 'EXACT' : m._ocr ? 'OCR' : Math.round((m.similarity||0)*100)+'% visual';
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">'
          + '<div onclick="openMsCandidateSheet(' + i + ')" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer">'
          + thumbHTML
          + (m.image_url ? '<img src="' + m.image_url + '" style="width:42px;height:58px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0" onerror="this.style.display=\'none\'" loading="lazy" decoding="async">' : '')
          + '<div style="flex:1;min-width:0">'
          + '<div style="font-size:.8rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.name + '</div>'
          + '<div style="font-size:.65rem;color:var(--muted)">' + (m.set_name||m.set_code||'') + ' · #' + (m.card_number||'?') + '</div>'
          + '<div style="font-size:.62rem;color:var(--accent2);margin-top:1px">' + conf + ' · <span style="color:var(--muted)">tap to change</span></div>'
          + '</div>'
          + '</div>'
          + '<input type="checkbox" ' + (r.included?'checked':'') + ' onchange="event.stopPropagation();_multiScanResults[' + i + '].included=this.checked;updateMsAddBtn()" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent2);flex-shrink:0">'
          + '</div>';
      });

      container.innerHTML = '<div style="font-size:.72rem;color:var(--muted);margin-bottom:14px">'
        + matched.length + ' of ' + _multiScanResults.length + ' cards matched. Tap any card to change its match.'
        + '</div>'
        + rows.join('');

      populateBinderDropdown('msBinder', currentBinderId);
      document.getElementById('msProgressView').style.display = 'none';
      document.getElementById('msReviewView').style.display   = 'block';
      document.getElementById('msFooter').style.display       = 'flex';
      updateMsAddBtn();
    }

    function updateMsAddBtn() {
      var n = _multiScanResults.filter(function(r) { return r.included && r.selectedMatch; }).length;
      var btn = document.getElementById('msAddBtn');
      if (btn) btn.textContent = 'ADD ' + n + ' CARD' + (n !== 1 ? 'S' : '') + ' →';
    }

    async function bulkAddMultiScan() {
      var binderId = document.getElementById('msBinder') ? document.getElementById('msBinder').value || null : null;
      var toAdd    = _multiScanResults.filter(function(r) { return r.included && r.selectedMatch; });
      if (toAdd.length === 0) { showToast('No cards selected'); return; }

      var btn = document.getElementById('msAddBtn');
      if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }

      var success = 0, failed = 0;
      for (var ri = 0; ri < toAdd.length; ri++) {
        var m = toAdd[ri].selectedMatch;
        var msRow = {
          user_id:        currentUser.id,
          api_card_id:    m.id            || null,
          card_name:      m.name,
          set_name:       m.set_name      || null,
          set_code:       m.set_code      || null,
          card_number:    m.card_number   || null,
          card_image_url: m.image_url     || null,
          game_type:      'pokemon',
          quantity:       1,
          binder_id:      binderId        || null,
        };
        applyOverrideToInsertRow(msRow);
        var res = await sb.from('collection_items').insert(msRow);
        if (res.error) { console.error('Multi-scan add error:', res.error.message); failed++; }
        else success++;
      }

      closeModal('multiScanModal');
      await loadCollection();
      // Multi-scan adds bypass the modal-save flow, so trigger the
      // collection-size badge checks here too.
      try { checkBadge_stacked(); } catch(_) {}
      try { checkBadge_phantom_p2(); } catch(_) {}
      renderCollection();
      // Navigate to the collection page so the user sees their new cards
      showPage('collection'); setMobileNav('collection');
      showToast('✓ ' + success + ' card' + (success !== 1 ? 's' : '') + ' added' + (failed > 0 ? ' (' + failed + ' failed)' : '!'));
      if (btn) { btn.disabled = false; }
    }
