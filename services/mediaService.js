import { env } from '../config/env.js';
import { twilioBasicAuthHeader } from '../config/twilio.js';
import { logger } from '../utils/logger.js';
import { badGateway, badRequest } from '../utils/httpError.js';

/**
 * Fetches the prescription photo Twilio is holding for us.
 *
 * Two wrinkles this handles:
 *  1. `api.twilio.com/.../Media/ME…` requires Basic auth, then 307s to a signed
 *     CDN URL. Per the fetch spec, `Authorization` is dropped on a cross-origin
 *     redirect — which is what we want, since the CDN rejects it. Some runtimes
 *     forward it anyway, so a 400/401/403 triggers a manual two-hop retry.
 *  2. WhatsApp images arrive as JPEG/PNG/WebP but the content type is worth
 *     checking: a PDF or video would be passed straight to Gemini otherwise.
 */

const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const FETCH_TIMEOUT_MS = 20_000;

function isTwilioApiUrl(url) {
  try {
    return new URL(url).hostname.endsWith('.twilio.com');
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBuffer(response, url) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > env.MAX_MEDIA_BYTES) {
    throw badRequest(`Image is ${Math.round(declaredLength / 1024)} KB, over the ${Math.round(env.MAX_MEDIA_BYTES / 1024)} KB limit.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw badGateway(`Downloaded 0 bytes from ${url}`);
  }
  if (buffer.length > env.MAX_MEDIA_BYTES) {
    throw badRequest(`Image is ${Math.round(buffer.length / 1024)} KB, over the ${Math.round(env.MAX_MEDIA_BYTES / 1024)} KB limit.`);
  }

  return buffer;
}

/**
 * @param {string} mediaUrl      Value of MediaUrl0 from the Twilio webhook.
 * @param {string} [declaredType] Value of MediaContentType0, used as a hint.
 * @returns {Promise<{buffer: Buffer, mimeType: string, bytes: number}>}
 */
export async function downloadTwilioMedia(mediaUrl, declaredType) {
  if (typeof mediaUrl !== 'string' || !/^https?:\/\//i.test(mediaUrl)) {
    throw badRequest(`Invalid media URL: ${mediaUrl}`);
  }

  const headers = isTwilioApiUrl(mediaUrl) ? { Authorization: twilioBasicAuthHeader } : {};
  const startedAt = Date.now();

  let response = await fetchWithTimeout(mediaUrl, { headers, redirect: 'follow' });

  // Retry path for runtimes that forward Authorization across the CDN redirect.
  if (!response.ok && [400, 401, 403].includes(response.status) && isTwilioApiUrl(mediaUrl)) {
    logger.warn('media.redirect_retry', { status: response.status, mediaUrl });

    const hop = await fetchWithTimeout(mediaUrl, { headers, redirect: 'manual' });
    const location = hop.headers.get('location');

    if (location) {
      response = await fetchWithTimeout(location, { redirect: 'follow' });
    }
  }

  if (!response.ok) {
    throw badGateway(`Twilio media download failed with HTTP ${response.status}`, { mediaUrl, status: response.status });
  }

  const buffer = await readBuffer(response, mediaUrl);
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const hintType = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  const mimeType = ACCEPTED_IMAGE_TYPES.has(headerType) ? headerType : hintType || headerType || 'image/jpeg';

  if (!ACCEPTED_IMAGE_TYPES.has(mimeType)) {
    throw badRequest(
      `Unsupported attachment type "${mimeType}". Send the prescription as a photo (JPEG, PNG, WebP or HEIC).`,
    );
  }

  logger.info('media.downloaded', { bytes: buffer.length, mimeType, durationMs: Date.now() - startedAt });

  // Gemini has no HEIC decoder; WhatsApp transcodes to JPEG in practice, so
  // label it as such rather than rejecting a photo that is almost certainly fine.
  const geminiMimeType = mimeType === 'image/heic' || mimeType === 'image/heif' ? 'image/jpeg' : mimeType;

  return { buffer, mimeType: geminiMimeType, bytes: buffer.length };
}
