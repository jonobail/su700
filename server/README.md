# SU700 YouTube helper

A small Node server (no npm dependencies) that lets the SU700 web app sample **short clips** of
YouTube videos. Visitors preview videos in YouTube's own embedded player; this server only ever
returns the selected clip, at most `MAX_SNIPPET_SECONDS` (30 s by default), as a WAV.

## How a sample is taken

1. The app checks `GET /api/health` → `{ youtube: true | false }`. If the helper is unreachable,
   disabled, or out of daily quota, the app hides YouTube input and uploads still work.
2. The visitor marks a start point and length and presses SAMPLE. The app runs an invisible
   Cloudflare Turnstile check, then calls `POST /api/token` with
   `{ videoId, start, length, turnstileToken }`. The server verifies Turnstile, validates the
   video ID, reads the video's metadata with `yt-dlp -J` (cached 1 h), rejects live streams and
   videos longer than `MAX_VIDEO_SECONDS`, clamps the clip, applies rate limits, and returns an
   HMAC-signed token (5-minute expiry, bound to a hash of the client's IP).
3. The app fetches `GET /api/snippet?token=…`. The token is single-use. The server resolves the
   audio stream with `yt-dlp -g` (cached 1 h) and pipes
   `ffmpeg -ss <start> -t <length> … -f wav pipe:1` straight to the response
   (`audio/wav`, `Cache-Control: no-store`, nothing written to disk). ffmpeg is killed if the
   client disconnects or after 60 s, and the response is hard-capped at the clip's byte size.

Limits (all configurable, all in memory): per IP 6 tokens per hour and 30 minutes of clips per
day; 500 clips per day in total, after which `/api/health` reports `youtube: false`; at most 3
ffmpeg processes at once (else 503). Every request is logged as one JSON line with a salted IP
hash, never the raw IP.

Error replies look like `{ "error": "human message", "code": "machine_code" }`, with codes such
as `rate_limited` (429), `video_too_long` / `live_video` (422), `busy` (503),
`token_expired` / `token_used` / `token_invalid` (401) and `turnstile_failed` (403).

## Local development

```bash
npm run setup:tools   # yt-dlp, ffmpeg and deno into server/bin (skips any already on PATH)
npm run server        # http://127.0.0.1:3700
npm start             # the app; /api is proxied to the helper
```

With `NODE_ENV` unset, no configuration is needed: the helper uses Cloudflare's always-pass
Turnstile test secret (the app's dev build uses the matching test site key), a random token
secret, and accepts any origin.

## Hosting it

Configuration lives in environment variables; see [`.env.example`](.env.example). In
production (`NODE_ENV=production`) the helper refuses to start without `TOKEN_SECRET`,
`TURNSTILE_SECRET` and `ALLOWED_ORIGINS`.

```bash
docker build -t su700-helper server
docker run -d --name su700-helper --restart unless-stopped --env-file server/.env -p 127.0.0.1:3700:3700 su700-helper
```

Rebuild the image regularly (`docker build --no-cache …`): YouTube changes often, and each
build fetches the newest yt-dlp.

### Option A: a home machine behind a Cloudflare Tunnel (recommended)

YouTube blocks or throttles datacenter IP ranges far more often than home connections, so the
most reliable place to run the helper is a machine on your home network. A Cloudflare Tunnel
exposes it over HTTPS without opening any ports:

1. Run the container as above, bound to `127.0.0.1:3700`.
2. Install `cloudflared`, then `cloudflared tunnel login`,
   `cloudflared tunnel create su700`, and route a hostname to it:
   `cloudflared tunnel route dns su700 su700-helper.example.com`.
3. Point the tunnel at the helper (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: su700
   credentials-file: /home/you/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: su700-helper.example.com
       service: http://127.0.0.1:3700
     - service: http_status:404
   ```
   and run it as a service: `sudo cloudflared service install`.
4. Set `TRUST_CLOUDFLARE=true` so rate limits use the visitor's IP (`CF-Connecting-IP`)
   rather than the tunnel's.

### Option B: a cloud host

Any container host works (Fly.io, Render, a small VPS…): deploy the image, set the environment
variables, and put HTTPS in front of it. If a reverse proxy or load balancer sits in front, set
`TRUST_PROXY=true` (or `TRUST_CLOUDFLARE=true` behind Cloudflare) so client IPs are read
correctly. Expect YouTube to refuse some requests from datacenter IPs; if that becomes
frequent, Option A is the fix.

### Kill switch

Set `DISABLE_YOUTUBE=true` and restart: `/api/health` reports `youtube: false`, the app shows
its "offline" note, and token/snippet requests are refused.
