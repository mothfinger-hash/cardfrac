// =========================================================
// PathBinder — Card Photo Update Modal (lazy-loaded)
//
// Extracted from pb-app.js. Crop + optional bg removal modal
// that fires when the user clicks "Edit Photo" on a binder
// card. Loaded on first invocation or at browser idle.
// =========================================================

    // ── Card Photo Update Modal (crop + optional bg removal) ──────────────
    var _cpItemId   = null;
    var _cpCropper  = null;
    var _cpBgBusy   = false;
    var _cpOrigBlob = null;
    var _cpSide     = 'front';   // 'front' | 'back' — which photo we're editing
    var _cpDirty    = false;     // true if user has changed something un-saved

    async function _cpLoadCropperJs() {
      if (window.Cropper) return;
      if (!document.getElementById('cropperCss')) {
        var link  = document.createElement('link');
        link.id   = 'cropperCss';
        link.rel  = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css';
        document.head.appendChild(link);
      }
      await new Promise(function(resolve, reject) {
        var s  = document.createElement('script');
        s.src  = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js';
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    function openCardPhotoModal(itemId, side) {
      _cpItemId = itemId;
      _cpSide   = (side === 'back') ? 'back' : 'front';
      _cpDirty  = false;
      cpResetFile();
      _cpUpdateSideTabs();
      openModal('cardPhotoModal');
      // Pre-load the existing photo for the chosen side so the user
      // can re-crop / rotate / remove-bg without re-uploading anything.
      _cpTryLoadExisting();
    }

    function closeCardPhotoModal() {
      if (_cpCropper) { _cpCropper.destroy(); _cpCropper = null; }
      _cpDirty = false;
      // Clear any in-flight animated-dots timers so they don't keep
      // running after the modal closes.
      var btn    = document.getElementById('cpSaveBtn');
      var status = document.getElementById('cpStatus');
      var bgBtn  = document.getElementById('cpBgBtn');
      [btn, status, bgBtn].forEach(function(el) {
        if (!el) return;
        var t = _processingTimers.get(el);
        if (t) { clearInterval(t); _processingTimers.delete(el); }
      });
      if (btn)   { btn.textContent = 'Save Photo'; btn.disabled = false; }
      if (bgBtn) { bgBtn.textContent = 'Remove Background'; bgBtn.disabled = false; }
      if (status) status.textContent = '';
      closeModal('cardPhotoModal');
    }

    // Switch between Front/Back tabs. If there are unsaved edits we ask
    // the user before discarding them.
    function cpSwitchSide(side) {
      if (side !== 'front' && side !== 'back') return;
      if (side === _cpSide) return;
      if (_cpDirty) {
        if (!confirm('Discard unsaved edits to the ' + _cpSide + ' photo?')) return;
      }
      _cpSide  = side;
      _cpDirty = false;
      cpResetFile();
      _cpUpdateSideTabs();
      _cpTryLoadExisting();
    }

    function _cpUpdateSideTabs() {
      var f = document.getElementById('cpSideFront');
      var b = document.getElementById('cpSideBack');
      function activate(el) {
        if (!el) return;
        el.style.borderColor = 'var(--accent)';
        el.style.background  = 'rgba(26,199,160,.10)';
        el.style.color       = 'var(--accent)';
      }
      function deactivate(el) {
        if (!el) return;
        el.style.borderColor = 'var(--border)';
        el.style.background  = 'transparent';
        el.style.color       = 'var(--muted)';
      }
      if (_cpSide === 'front') { activate(f); deactivate(b); }
      else                     { activate(b); deactivate(f); }
      var hint = document.getElementById('cpUploadHint');
      if (hint) {
        hint.textContent = 'Click or drag a new ' + _cpSide + ' photo here';
      }
    }

    // Pre-load the existing photo (for whichever side is selected) into
    // the cropper. If there isn't one, the upload zone stays visible.
    async function _cpTryLoadExisting() {
      if (!_cpItemId) return;
      var item = collectionItems.find(function(c) { return String(c.id) === String(_cpItemId); });
      if (!item) return;
      var url = (_cpSide === 'back') ? item.card_back_image_url : item.card_image_url;
      if (!url) return;
      try {
        var res = await fetch(url, { mode: 'cors', cache: 'no-store' });
        if (!res.ok) return;
        var blob = await res.blob();
        var name = 'existing-' + _cpSide + '.' + ((blob.type || '').split('/')[1] || 'png');
        var file = new File([blob], name, { type: blob.type || 'image/png' });
        await cpLoadFile(file);
        var st = document.getElementById('cpStatus');
        if (st) st.textContent = 'Editing your saved ' + _cpSide + ' photo — adjust and save, or pick a different one';
      } catch(e) {
        // CORS or network failure — silently fall back to upload-zone state.
        console.warn('[cpTryLoadExisting]', e);
      }
    }

    function cpHandleDrop(e) {
      e.preventDefault();
      var dz = document.getElementById('cpUploadZone');
      if (dz) dz.style.borderColor = 'var(--border)';
      var file = e.dataTransfer && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) { _cpDirty = true; cpLoadFile(file); }
    }

    // Wrapper used by the <input> onchange so we can flag dirty state
    // before delegating to cpLoadFile.
    function cpFileInputChange(input) {
      var f = input && input.files && input.files[0];
      if (!f) return;
      _cpDirty = true;
      cpLoadFile(f);
    }

    async function cpLoadFile(file) {
      if (!file) return;
      _cpOrigBlob = file;
      await _cpLoadCropperJs();

      document.getElementById('cpUploadZone').style.display = 'none';
      document.getElementById('cpCropZone').style.display   = '';
      document.getElementById('cpSaveBtn').style.display    = '';

      var btn = document.getElementById('cpBgBtn');
      if (btn) { btn.textContent = 'Remove Background'; btn.disabled = false; btn.dataset.done = ''; btn.style.borderColor = 'var(--teal)'; btn.style.color = 'var(--teal)'; }
      document.getElementById('cpStatus').textContent = '';

      if (_cpCropper) { _cpCropper.destroy(); _cpCropper = null; }

      var img = document.getElementById('cpCropImg');
      img.src = URL.createObjectURL(file);
      img.onload = function() {
        _cpCropper = new Cropper(img, {
          viewMode:     1,
          aspectRatio:  NaN,
          autoCropArea: 0.92,
          background:   true,
          movable:      true,
          zoomable:     true,
          rotatable:    true,   // was false — silently broke the Rotate 90° button
          guides:       true,
        });
      };
    }

    function cpRotate() {
      if (_cpCropper) { _cpCropper.rotate(90); _cpDirty = true; }
    }

    function cpResetFile() {
      if (_cpCropper) { _cpCropper.destroy(); _cpCropper = null; }
      var fi = document.getElementById('cpFileInput');
      if (fi) fi.value = '';
      var uz = document.getElementById('cpUploadZone');
      if (uz) uz.style.display = '';
      var cz = document.getElementById('cpCropZone');
      if (cz) cz.style.display = 'none';
      var sb2 = document.getElementById('cpSaveBtn');
      if (sb2) sb2.style.display = 'none';
      var st = document.getElementById('cpStatus');
      if (st) st.textContent = '';
      _cpOrigBlob = null;
    }

    async function cpRemoveBg() {
      if (_cpBgBusy) return;
      _cpBgBusy = true;
      var btn    = document.getElementById('cpBgBtn');
      var status = document.getElementById('cpStatus');
      var img    = document.getElementById('cpCropImg');

      // Grab the current crop so bg-removal sees the same framing
      var sourceBlob = _cpOrigBlob;
      if (_cpCropper) {
        var canvas = _cpCropper.getCroppedCanvas({ maxWidth: 1200, maxHeight: 1600 });
        sourceBlob = await new Promise(function(res) { canvas.toBlob(res, 'image/png'); });
      }

      // Library is pre-loaded as a module at page start (window._imglyRemoveBg)
      var removeBg2 = window._imglyRemoveBg;
      if (!removeBg2) {
        if (status) status.textContent = 'Background removal unavailable — CDN blocked. Try refreshing.';
        if (btn)    { btn.textContent = 'Remove Background'; btn.disabled = false; }
        _cpBgBusy = false;
        return;
      }

      if (btn)    { btn.disabled = true; _setProcessingText(btn, 'Processing…'); }
      if (status) _setProcessingText(status, 'Loading AI model (~50 MB, cached after first use)…');

      try {
        var result = await removeBg2(sourceBlob, {
          publicPath: window._imglyPublicPath || 'https://staticimgly.com/@imgly/background-removal-data/1.4.5/dist/',
          progress: function(k, cur, tot) {
            // Use _setProcessingText so it cancels the loading-model
            // animation timer; ending with … keeps the dots animating
            // through each percentage update.
            if (tot && status) _setProcessingText(status, 'Removing background ' + Math.round(cur / tot * 100) + '%…');
          }
        });

        // Replace cropper source with the bg-removed PNG. We INTENTIONALLY
        // do NOT restore the previous getData() — getCroppedCanvas already
        // baked the user's rotation/scale and crop region into `result`,
        // so the new image's natural orientation is correct. Re-applying
        // a saved rotate value caused the photo to rotate twice on every
        // bg-removal pass.
        // autoCropArea is 1.0 here (vs 0.92 in cpLoadFile) because the
        // bg-removed image IS the user's previous crop result — shrinking
        // back to 92% would silently cut a margin off and feel like the
        // crop got reset.
        _cpOrigBlob = result;
        if (_cpCropper) { _cpCropper.destroy(); _cpCropper = null; }
        img.src = URL.createObjectURL(result);
        img.onload = function() {
          _cpCropper = new Cropper(img, {
            viewMode:     1,
            aspectRatio:  NaN,
            autoCropArea: 1.0,
            background:   true,
            movable:      true,
            zoomable:     true,
            rotatable:    true,
            guides:       true,
          });
        };
        // Use _setProcessingText for both completion lines so the loading
        // animation timer gets cleared — otherwise it keeps overwriting
        // the success text with animated dots indefinitely.
        if (btn) {
          _setProcessingText(btn, 'Background Removed');
          btn.dataset.done = '1';
          btn.style.borderColor = 'var(--accent)';
          btn.style.color = 'var(--accent)';
        }
        if (status) _setProcessingText(status, 'Adjust crop if needed, then save');
        _cpDirty = true;
      } catch (err) {
        console.error('[BG Remove]', err);
        // Surface a more diagnostic message — most failures are network
        // (CDN model download blocked) or memory (mobile Safari OOM
        // on large photos). Generic "failed" left users guessing.
        var msg = (err && err.message) ? String(err.message) : '';
        var hint = /network|fetch|load|CORS|abort/i.test(msg)
          ? ' (model download blocked — check connection or extension)'
          : /memory|allocat|wasm/i.test(msg)
          ? ' (out of memory — try a smaller photo)'
          : '';
        if (status) _setProcessingText(status, 'Background removal failed — original photo kept' + hint);
        if (btn)    { _setProcessingText(btn, 'Remove Background'); btn.disabled = false; }
      }
      _cpBgBusy = false;
    }

    async function cpSavePhoto() {
      if (!_cpItemId || !_cpCropper) return;
      var btn    = document.getElementById('cpSaveBtn');
      var status = document.getElementById('cpStatus');

      // Animated "Saving …" → "Saving ..>" → "Saving ...>" feedback so
      // the user can tell something is happening even when the network
      // is slow. _setProcessingText only animates strings ending with …
      // or .. — finish messages render as-is.
      function setBusy(msg) {
        if (btn)    _setProcessingText(btn, msg);
        if (status) _setProcessingText(status, msg);
      }
      function setDoneText(msg) {
        if (btn)    _setProcessingText(btn, msg);    // clears the timer
        if (status) _setProcessingText(status, msg);
      }
      function reEnable(label) {
        if (btn) { _setProcessingText(btn, label || 'Save Photo'); btn.disabled = false; }
      }

      if (btn) btn.disabled = true;
      setBusy('Saving…');

      // Commit any in-progress crop drag to the cropper's internal
      // state before extracting — Cropper.js sometimes lags one frame
      // behind a fast click+drop, leaving the visual crop box ahead
      // of the data backing it.
      try { _cpCropper.crop(); } catch(_) {}

      // Log the crop region we're about to export so it's easy to
      // confirm the saved image actually matches the visible crop.
      try {
        var d = _cpCropper.getData();
        console.log('[cpSavePhoto] crop region (px):', d);
      } catch(_) {}

      // Helper — wrap any promise with a timeout so a hung upload
      // can't leave the UI stuck on "Saving" forever.
      function withTimeout(p, ms, label) {
        return Promise.race([
          p,
          new Promise(function(_, rej) {
            setTimeout(function() { rej(new Error((label || 'Operation') + ' timed out after ' + (ms / 1000) + 's')); }, ms);
          })
        ]);
      }

      try {
        // Export the cropped region as webp (smaller than PNG); fall
        // back to PNG only if the browser can't encode webp from canvas
        setBusy('Encoding image…');
        var canvas = _cpCropper.getCroppedCanvas({ maxWidth: 1200, maxHeight: 1600 });
        var blob = await new Promise(function(res) { canvas.toBlob(res, 'image/webp', 0.85); });
        var ext = 'webp', contentType = 'image/webp';
        // toBlob does NOT return null when the engine can't encode WebP — it is
        // spec-mandated to silently substitute image/png and hand back a
        // perfectly truthy blob, with blob.type telling the truth. The old
        // `if (!blob)` therefore never fired on the very case this fallback was
        // written for, and PNG bytes shipped under a .webp name with
        // contentType 'image/webp'. Measured live: 2 of 14 .webp-named
        // originals in card-photos are actually PNG. Test the TYPE, not nullness.
        if (!blob || blob.type !== 'image/webp') {
          blob = await new Promise(function(res) { canvas.toBlob(res, 'image/png'); });
          ext = 'png'; contentType = 'image/png';
        }
        if (!blob) throw new Error('Failed to encode the image');

        setBusy('Uploading…');
        var path = 'collection/' + currentUser.id + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
        var upResult = await withTimeout(
          sb.storage.from('card-photos').upload(path, blob, { upsert: false, contentType: contentType }),
          60000, 'Upload'
        );
        if (upResult.error) throw upResult.error;

        // Generate + upload variants from the already-cropped canvas
        // (cheaper than re-decoding). Fire-and-forget so user flow
        // doesn't wait on the variant encodes/uploads.
        try {
          var _cropW = canvas.width;
          var _cropH = canvas.height;
          var _vsizes = [200, 400].filter(function(s) { return s < _cropW; });
          var _variantBlobs = {};
          for (var _i = 0; _i < _vsizes.length; _i++) {
            (function(w) {
              var th = Math.round(_cropH * (w / _cropW));
              var vc = document.createElement('canvas');
              vc.width = w; vc.height = th;
              vc.getContext('2d').drawImage(canvas, 0, 0, w, th);
              vc.toBlob(function(vb) {
                if (!vb) return;
                // Same PNG-fallback guard as the main blob above and as
                // _imgToWebpAndVariants in pb-app.js. Uploading a non-WebP blob
                // here is worse than uploading nothing: it lands under a .webp
                // name stamped contentType 'image/webp', so the URL returns 200,
                // the <img> onerror cascade never fires, and the client
                // downloads a ~141 KB PNG believing it is a ~13 KB thumbnail.
                // A missing variant 400s and falls back honestly. Skip it — the
                // nightly backfill-card-photo-variants job uses Pillow and will
                // generate the real one.
                if (vb.type !== 'image/webp') {
                  console.warn('[variants] engine cannot encode WebP (got ' + vb.type +
                               ') — skipping ' + w + 'px; nightly backfill will handle it');
                  return;
                }
                var vpath = path.replace(/(\.[^.]+)?$/, '-' + w + '.webp');
                sb.storage.from('card-photos').upload(vpath, vb, {
                  upsert: false, contentType: 'image/webp',
                }).then(function(r) {
                  if (r.error) console.warn('[variant upload error]', vpath, r.error.message);
                }).catch(function(e) { console.warn('[variant upload threw]', vpath, e); });
              }, 'image/webp', 0.8);
            })(_vsizes[_i]);
          }
        } catch (_vErr) { console.warn('[variants from canvas failed]', _vErr); }

        var urlData = sb.storage.from('card-photos').getPublicUrl(path);
        var publicUrl = urlData.data && urlData.data.publicUrl;

        // Save to either card_image_url (front) or card_back_image_url (back)
        // depending on the active side tab.
        setBusy('Updating record…');
        var updateField = (_cpSide === 'back') ? 'card_back_image_url' : 'card_image_url';
        var patch = {};
        patch[updateField] = publicUrl;
        var dbResult = await withTimeout(
          sb.from('collection_items').update(patch).eq('id', _cpItemId),
          15000, 'Save'
        );
        if (dbResult.error) {
          var msg = (dbResult.error.message || '').toLowerCase();
          if (_cpSide === 'back' && (msg.indexOf('column') !== -1 || msg.indexOf('schema') !== -1)) {
            var sql = "alter table collection_items\n  add column if not exists card_back_image_url text;";
            console.log('%cBack-Photo SQL Migration:', 'color:orange;font-weight:bold');
            console.log(sql);
            setDoneText('Database needs migration — see console for SQL');
            showToast('Run the back-photo SQL migration in Supabase first (see console)');
            reEnable();
            return;
          }
          throw dbResult.error;
        }

        // Update local cache so the binder view reflects it immediately
        var local = collectionItems.find(function(c) { return String(c.id) === String(_cpItemId); });
        if (local) local[updateField] = publicUrl;
        _cpDirty = false;
        renderCollection();

        // Clear any animation timers before closing
        setDoneText('Saved');
        showToast((_cpSide === 'back' ? 'Back' : 'Front') + ' photo updated!');
        closeCardPhotoModal();
        openBinderCardDetail(_cpItemId);
      } catch (err) {
        console.error('[cpSavePhoto]', err);
        var em = (err && err.message) ? err.message : String(err);
        setDoneText('Save failed — ' + em);
        reEnable();
      }
    }
    // ── End Card Photo Update Modal ───────────────────────────────────────

