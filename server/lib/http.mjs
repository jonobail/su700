// Small HTTP helpers: client IP, CORS, JSON I/O, logging, Turnstile verification.

/** Client IP: CF-Connecting-IP / X-Forwarded-For only when explicitly trusted. */
export function clientIp(req, cfg) {
  if (cfg.trustCloudflare) {
    const ip = req.headers['cf-connecting-ip'];
    if (typeof ip === 'string' && ip) return ip.trim();
  }
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Applies CORS headers. Returns false when the request carries an Origin that isn't allowed
 * (the caller should answer 403). Requests without an Origin (same-origin via the dev proxy,
 * curl) are let through; CORS only governs browsers.
 */
export function cors(req, res, cfg) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return true;
  const allowed = cfg.allowedOrigins === null || cfg.allowedOrigins.includes(origin);
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

export function json(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Error reply with a stable machine-readable code plus a human message. */
export function fail(res, status, code, message, headers) {
  res.errorCode = code; // picked up by the request log
  json(res, status, { error: message, code }, headers);
}

export function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { code: 'bad_request' }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { code: 'bad_request' }));
      }
    });
    req.on('error', reject);
  });
}

/** One JSON line per request. Only salted IP hashes, never raw IPs. */
export function log(entry) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

/** Cloudflare Turnstile siteverify. */
export async function verifyTurnstile(secret, token, ip) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
