<p align="center"><img src="docs/su700-logo.svg" alt="Yamaha SU700 Sampling Unit" width="560"></p>

# SU700

A browser emulation of the Yamaha SU700 Sampling Unit (1999), built with Angular. The input
audio comes from an uploaded file or a short clip sampled from a YouTube video, instead of the
analog inputs.

**Live demo:** _coming soon_ <!-- TODO: https://jonobail.github.io/su700/ once Pages is enabled -->

## YouTube sampling in the demo

Paste a YouTube link in the **AUDIO IN** tray and press **SAMPLE…**. The video plays in
YouTube's own embedded player so you can find the part you want; mark a start point, pick a
length (5–30 s) and press **SAMPLE**. Only that clip is fetched, decoded and added to your
library, just like an uploaded file. There are rate limits (a few samples per hour, 30 minutes
of clips per day), and videos must be 10 minutes or shorter. If the helper server is offline,
the YouTube input is disabled and uploads keep working.

The clips come from a small helper server (`server/`) that uses yt-dlp and ffmpeg behind a
Cloudflare Turnstile check and signed single-use tokens. It never serves whole tracks. See
[server/README.md](server/README.md) for how it works and how to host it (a home machine
behind a Cloudflare Tunnel is recommended).

## Running locally

```bash
npm install
npm run setup:tools   # one-time: yt-dlp, ffmpeg and deno into server/bin (skips any on PATH)
npm run server        # YouTube helper on :3700 (only needed for YouTube sampling)
npm start             # app on http://localhost:4200, proxies /api to the helper
npm test              # unit tests (tokens, rate limiter, link parsing)
```

No configuration is needed locally: the dev build and the helper use Cloudflare's Turnstile test
keys. Uploaded files work without the helper. Sources are stored in the browser's IndexedDB.

## Deploying

- **App:** `.github/workflows/pages.yml` builds with `--base-href /su700/` and publishes to
  GitHub Pages on every push to `master`. Set the helper URL and Turnstile site key in
  `src/environments/environment.ts` first.
- **Helper:** see [server/README.md](server/README.md) (Docker image, Cloudflare Tunnel, env vars).

## Playing it

The controls follow the Owner's Manual. To get a first loop going:

1. Upload audio or sample a YouTube clip in the **AUDIO IN** tray, then press **▶ PLAY** there.
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
- `src/app/audio/`: Web Audio engine, source storage and loading, YouTube snippet client
- `src/app/source/`: the AUDIO IN tray and the YouTube sampler dialog
- `src/environments/`: helper URL and Turnstile site key (dev and production)
- `src/app/unit-controller.ts`: front-panel behaviour (screens, pads, buttons, sampling)
- `src/app/panel/`: the faceplate, knobs, dial and VFD display
- `server/`: the YouTube snippet helper (Node, yt-dlp, ffmpeg) and its Dockerfile

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's emulated so far and what's next.
