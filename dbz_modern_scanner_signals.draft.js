/* ===========================================================================
 * DRAFT — Scanner signals for the two modern Dragon Ball games
 * Target: pb-scanner.js  →  detectScanTcg()  (currently ~L3981–4082)
 * Not applied to pb-scanner.js yet — review the collision reasoning first,
 * then I can drop it in and run the syntax check.
 *
 * WHY set-code-anchored: the three Dragon Ball games are only reliably
 * separable by their card-number prefix, because character names (Goku,
 * Vegeta, …) appear on all three. The prefixes are mutually exclusive:
 *     vintage dbz (Panini/Score) : (dbz|db)#-#   + Style / Power Level / Combat
 *     Super CCG   (dbsccg)       : BT#-# (EB/SD)  + Combo Power / Combo Energy
 *     Fusion World(dbfusion)     : FB#-# / FS#-# / SB#-#  + "Fusion World"
 * None of BT/FB/FS/SB match (dbz|db)#-#, so the modern blocks cannot poach
 * the vintage dbz block, and BT vs FB separates the two modern games.
 * ======================================================================== */


/* --- EDIT 1: scores initializer (currently L3984) -------------------------
 * add dbsccg + dbfusion keys: */
// var scores = { pokemon: 0, magic: 0, yugioh: 0, onepiece: 0, gundam: 0,
//                dbz: 0, dbsccg: 0, dbfusion: 0, lorcana: 0 };


/* --- EDIT 2: insert these two blocks right AFTER the existing Dragon Ball Z
 * (Panini/Score) block (after L4060) and BEFORE the Lorcana block: -------- */

      // Dragon Ball Super CCG signals (Bandai 2017+ — the game between the
      // vintage Panini/Score dbz and Fusion World). Anchored on BT##-###,
      // which is unique to Super CCG. "Combo Power/Energy" and the
      // Leader/Battle/Extra/Unison card types are Super-CCG vocabulary that
      // never appears on the Style/Power-Level vintage cards, so this block
      // cannot poach the dbz block above.
      if (/\bbt\d+-\d+/i.test(text))            scores.dbsccg += 3; // BT31-055 — unique to Super CCG
      if (/\b(combo\s*power|combo\s*energy)\b/i.test(t)) scores.dbsccg += 2;
      if (/\b(leader|battle|extra|unison)\s*card\b/i.test(t)) scores.dbsccg += 1;
      // EB/SD codes overlap Gundam (EB01) and generic starter decks, so only
      // credit them to Super CCG when a DB-family word co-occurs.
      if (/\b(eb|sd)\d+-\d+/i.test(text) &&
          /\b(goku|vegeta|gohan|saiyan|dragon\s*ball|combo)\b/i.test(t)) scores.dbsccg += 2;

      // Dragon Ball Super Fusion World signals (Bandai 2024+ — the current
      // DB game). Anchored on FB/FS/SB set codes (all unique to Fusion World)
      // plus the "Fusion World" wordmark. Fusion World also uses "Combo", so
      // that word is only credited alongside a DB name; the set code is what
      // actually separates it from Super CCG.
      if (/\b(fb|fs|sb)\d+-\d+/i.test(text))    scores.dbfusion += 3; // FB10-001 / FS11-01 — unique
      if (/\bfusion\s*world\b/i.test(t))        scores.dbfusion += 3;
      if (/\bcombo\b/i.test(t) &&
          /\b(goku|vegeta|gohan|saiyan|dragon\s*ball)\b/i.test(t)) scores.dbfusion += 1;


/* --- EDIT 3: winner loop (currently L4077) --------------------------------
 * add the two new keys so they can win: */
// ['magic','yugioh','onepiece','gundam','dbz','dbsccg','dbfusion','lorcana']
//   .forEach(function(g) {
//     if (scores[g] > bestN && scores[g] >= 2) { best = g; bestN = scores[g]; }
//   });


/* --- EDIT 4: set-coded catalog lookup gate (currently L4883) --------------
 * modern DB rows store set_code='BT31'/'FB10' + card_number='BT31-055' (same
 * shape as Gundam/OP), so add both to the gate that searches by set code: */
// ((scanTcg === 'yugioh' || scanTcg === 'onepiece' || scanTcg === 'gundam'
//   || scanTcg === 'dbsccg' || scanTcg === 'dbfusion') && parsedSetCode && numStripped)


/* --- EDIT 5 (cosmetic): display-label maps -------------------------------
 * pb-scanner.js L1935 + L2149 and api/discord-bot.js game-label map — add:
 *   dbsccg   -> 'Dragon Ball Super CCG'
 *   dbfusion -> 'Dragon Ball Super: Fusion World'
 * and fix the existing dbz label from 'Dragon Ball Z Fusion World' (wrong)
 * to 'Dragon Ball Z (Score/Panini)'. */
