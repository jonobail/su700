# SU700 YouTube helper. Build from the repo root:
#   docker build -t su700-helper server
# yt-dlp is fetched at build time; YouTube changes often, so rebuild regularly
# (docker build --no-cache, or bump YTDLP_CACHEBUST) to pick up the latest release.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# deno: the JavaScript runtime yt-dlp uses to solve YouTube's player challenges.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

ARG YTDLP_CACHEBUST=1
RUN echo "yt-dlp build ${YTDLP_CACHEBUST}" \
 && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY --chown=node:node lib ./lib
COPY --chown=node:node youtube-server.mjs ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3700 \
    YTDLP=/usr/local/bin/yt-dlp \
    FFMPEG=/usr/bin/ffmpeg \
    DENO=/usr/local/bin/deno
USER node
EXPOSE 3700
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3700/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "youtube-server.mjs"]
