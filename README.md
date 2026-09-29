# SU700

A browser emulation of the Yamaha SU700 Sampling Unit (1999), built with Angular. The input
audio comes from an uploaded file or a YouTube link instead of the analog inputs.

## Running

```bash
npm install
npm run setup:ytdlp   # one-time: downloads yt-dlp into server/bin (skipped if already on PATH)
npm run server        # YouTube helper on :3700 (only needed for YouTube links)
npm start             # app on http://localhost:4200, proxies /api to the helper
```

Uploaded files work without the helper. Sources are stored in the browser's IndexedDB.

## Playing it

The controls follow the Owner's Manual. To get a first loop going:

1. Upload audio or paste a YouTube link in the **AUDIO IN** tray, then press **▶ PLAY** there.
2. Press **STANDBY/START/STOP** (top right). The screen shows `SELECT TRACK`: hit a pad
   (pads 1–2 are LOOP tracks), then **OK**.
3. On the `44K 16BIT STEREO` screen, press **STANDBY/START/STOP** to start sampling and again
   to stop. LOOP tracks get their loop length automatically.
4. Press the transport **▶** to run the sequencer. **●** then **▶** records pads, knobs and
   scenes (2-bar countdown).

Or select a track by hitting its pad and use **IMPORT → track** in the tray to load the
whole source onto it.

| Key | Action |
|---|---|
| `Q W E R T Y U I O P [ ]` | the 12 pads |
| Space | play / stop |
| ↑ ↓ | dial |
| ← → | cursor buttons |
| Enter / Esc | OK / CANCEL |

Knobs: drag vertically or scroll (Shift for fine), double-click to reset. Scene and marker
buttons: tap to recall or jump, hold 1.5 s to store.

In dev mode, `su700` in the browser console exposes the controller, sequencer and audio engine.

## Layout

- `src/app/core/`: data model, the 22 knob functions, sequencer
- `src/app/audio/`: Web Audio engine, source storage and loading
- `src/app/unit-controller.ts`: front-panel behaviour (screens, pads, buttons, sampling)
- `src/app/panel/`: the faceplate, knobs, dial and VFD display
- `server/`: yt-dlp helper for YouTube audio

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's emulated so far and what's next.
