import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Middleware for the unauthenticated /api/public surface the web app calls.
 */

/**
 * Allows the origins listed in CORS_ORIGINS. In development the Vite dev server
 * proxies /api, so requests are same-origin and this is a no-op.
 */
export function publicCors(req, res, next) {
  const origin = req.get('origin');

  if (origin && env.CORS_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

/**
 * Fixed-window, per-IP limit on uploads. Every upload costs a Gemini call and
 * up to five outbound messages, so an open endpoint needs a ceiling.
 *
 * In-memory, so it resets on restart and is per-instance. That is enough for a
 * single server; put a shared store behind it before scaling out.
 */
export function uploadRateLimit({ limit = env.PUBLIC_UPLOADS_PER_HOUR, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > limit) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return next(
        new HttpError(429, `Too many requests from this device. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`),
      );
    }

    return next();
  };
}
