# PathBinder sound effects

The Trade Analyzer plays five short audio cues. When the matching file
in this directory exists, Howler.js loads and plays it; otherwise the
JavaScript synth fallback in `index.html` runs (procedural Web Audio
shaped to roughly the right character).

## Expected files

Howler accepts `.wav`, `.opus`, and `.mp3` — drop whichever format you
have. The code's src array lists `.wav` first (largest but universal),
then `.opus` (smaller, modern), then `.mp3` (universal fallback).
You can ship just one format per cue; Howler picks the best one the
browser supports and ignores missing variants.

| File              | Cue                | Fires when…                            |
| ----------------- | ------------------ | -------------------------------------- |
| `scratch.*`       | DJ vinyl scratch   | Gauge slam — incoming whoosh           |
| `thud.*`          | Heavy body hit     | Gauge slam — impact body (layered)     |
| `flicker.*`       | CRT tube power-on  | Price breakdown reveals                |
| `lockin.*`        | Funky synth stab   | Side A or B locks in                   |
| `slap.*`          | Hand slap          | QR code lands after Create Trade Link  |
| `swipe.*`         | Card whoosh        | Navigating cards in the trade window   |

`scratch` and `thud` both fire at the same moment (T=370ms in the
analyze cinema). The pair makes the slam read as a complete physical
event — the whoosh leads, the thud lands. If you'd rather have them
play separately, change the call sites in `ftAnalyzeTrade`.

## Recommended properties

- **Length:** 100–600ms each (longest is the funky stab at ~550ms)
- **Loudness:** target -14 to -18 LUFS (don't blow ears out)
- **Format:** Opus VBR ~64kbps or MP3 ~96kbps. Each file should be
  well under 30kb.
- **No silence padding** at the start — the synth cues fire on cue
  with sample-accurate timing, real samples should match.

## Sourcing

- [freesound.org](https://freesound.org) — search "vinyl scratch
  short", "crt power on", "synth stab Dm", "slap percussion", "whoosh
  short". Filter by CC0 / CC-BY.
- [mixkit.co/free-sound-effects](https://mixkit.co/free-sound-effects/)
  — royalty-free, no attribution required.
- [zapsplat.com](https://zapsplat.com) — broader library, free with
  signup.

## Converting to opus

After downloading a `.wav` or `.mp3`, convert to opus via ffmpeg:

```bash
ffmpeg -i scratch.wav -c:a libopus -b:a 64k scratch.opus
ffmpeg -i scratch.wav -c:a libmp3lame -b:a 96k scratch.mp3
```

## How it falls back

If a file is missing or 404s, Howler's `onloaderror` flips a flag and
the synth twin (e.g. `_pbSynthScratch()`) runs instead. No code
changes needed — just drop files in and they'll be picked up on next
page load.
