// Development settings (`npm start`): API calls go through the dev-server /api proxy to
// `npm run server`, and Turnstile uses Cloudflare's always-pass test site key.
export const environment = {
  apiBase: '',
  turnstileSiteKey: '1x00000000000000000000AA',
};
