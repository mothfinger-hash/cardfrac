#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bootstrap all released Lorcana sets into the PathBinder catalog via TCGCSV.
#
# DRY-RUN BY DEFAULT — prints what each set would create, writes nothing.
# Pass --commit to actually write:
#
#     ./ingest_lorcana.sh              # preview every set
#     ./ingest_lorcana.sh --commit     # write every set
#
# Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY in the environment.
#
# Set codes are PathBinder-internal letter codes (NOT TCGCSV's numeric
# abbreviations) so the `ilike lor-<code>-*` id-prefix probes stay
# unambiguous (numeric "1" would also prefix-match "10","11","12").
#
# Groups/codes are the RELEASED sets as of 2026-07-01. Future sets excluded:
#   13 Attack of the Vine! (24666, 2026-07-17), Q3 (24734), 14 Hyperia City (24740).
# ---------------------------------------------------------------------------
set -uo pipefail

COMMIT="${1:-}"
if [[ -n "$COMMIT" && "$COMMIT" != "--commit" ]]; then
  echo "Usage: $0 [--commit]"; exit 1
fi

# code:groupId:label  (label is just for the log line)
SETS=(
  "TFC:22937:The First Chapter (1)"
  "ROF:23303:Rise of the Floodborn (2)"
  "ITI:23367:Into the Inklands (3)"
  "URR:23474:Ursula's Return (4)"
  "SSK:23536:Shimmering Skies (5)"
  "AZS:23746:Azurite Sea (6)"
  "ARI:24011:Archazia's Island (7)"
  "ROJ:24258:Reign of Jafar (8)"
  "FAB:24348:Fabled (9)"
  "WIW:24414:Whispers in the Well (10)"
  "WSP:24500:Winterspell (11)"
  "WLU:24617:Wilds Unknown (12)"
  "QDT:23528:Illumineer's Quest: Deep Trouble (Q1)"
  "QPH:24257:Illumineer's Quest: Palace Heist (Q2)"
  "D23:17690:D23 Promos"
  "D100:23305:Disney100 Promos"
  "DLPC:23234:Disney Lorcana Promo Cards"
)

echo ""
if [[ "$COMMIT" == "--commit" ]]; then
  echo ">>> COMMIT MODE — writing ${#SETS[@]} Lorcana sets to the catalog."
else
  echo ">>> DRY-RUN — previewing ${#SETS[@]} Lorcana sets (no writes). Re-run with --commit."
fi
echo ""

fail=0
for entry in "${SETS[@]}"; do
  code="${entry%%:*}"
  rest="${entry#*:}"
  grp="${rest%%:*}"
  label="${rest#*:}"
  # Strip a trailing " (N)" / " (Q1)" from the label to get the real set name.
  name="${label% (*}"
  echo "=========================================================="
  echo "  Lorcana $code — $label  (group $grp)"
  echo "=========================================================="
  # --category 71 bypasses the 0-rows bootstrap guard; --set-name because
  # Lorcana groups aren't in tcgplayer_group_map so the name won't auto-resolve.
  if ! python3 import_tcgcsv_set.py --group "$grp" --set-code "$code" --game lorcana \
        --category 71 --set-name "$name" $COMMIT; then
    echo "  !! FAILED: $code (group $grp)"
    fail=$((fail+1))
  fi
  echo ""
done

echo "Done. $fail set(s) reported an error."
[[ $fail -eq 0 ]]
