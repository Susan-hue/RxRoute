import { timingSafeEqual } from 'node:crypto';
import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { unauthorized } from '../utils/httpError.js';

let warnedAboutOpenApi = false;

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Guards the /api surface with a shared secret.
 *
 * These endpoints read patient phone numbers and prescription contents, so in
 * production API_KEY is mandatory — an unset key fails closed rather than
 * leaving patient data open. In development an unset key leaves the API open
 * (with a warning) so curl and the dashboard work out of the box.
 */
export function apiKeyAuth(req, res, next) {
  if (!env.API_KEY) {
    if (isProduction) {
      logger.error('api.key.missing', {
        hint: 'Set API_KEY — /api/* refuses to serve patient data unauthenticated in production.',
      });
      return next(unauthorized('API_KEY is not configured on this server'));
    }

    if (!warnedAboutOpenApi) {
      warnedAboutOpenApi = true;
      logger.warn('api.key.unset', { hint: 'API_KEY is not set — /api/* is unauthenticated (development only).' });
    }
    return next();
  }

  const header = req.get('x-api-key') ?? '';
  const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const presented = header || bearer;

  if (!presented || !safeEqual(presented, env.API_KEY)) {
    return next(unauthorized('Missing or invalid API key. Send it as x-api-key or Authorization: Bearer <key>.'));
  }

  return next();
}
