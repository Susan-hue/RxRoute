import twilio from 'twilio';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { forbidden } from '../utils/httpError.js';

/**
 * Verifies the X-Twilio-Signature header so the webhook cannot be spoofed by
 * anyone who discovers the URL.
 *
 * Twilio computes the signature over the exact URL it posted to. Behind ngrok
 * or any proxy, `req.protocol`/`req.host` describe the internal hop, not that
 * URL — so PUBLIC_BASE_URL is required to reconstruct it. Off by default
 * (VALIDATE_TWILIO_SIGNATURE=false) to keep first-run local testing frictionless;
 * turn it on for anything deployed.
 */
export function validateTwilioSignature(req, res, next) {
  if (!env.VALIDATE_TWILIO_SIGNATURE) return next();

  const signature = req.get('X-Twilio-Signature');
  if (!signature) {
    return next(forbidden('Missing X-Twilio-Signature header'));
  }

  if (!env.PUBLIC_BASE_URL) {
    logger.error('twilio.signature.misconfigured', {
      hint: 'VALIDATE_TWILIO_SIGNATURE=true requires PUBLIC_BASE_URL (e.g. https://abc123.ngrok-free.app)',
    });
    return next(forbidden('Webhook signature validation is misconfigured'));
  }

  const url = new URL(req.originalUrl, env.PUBLIC_BASE_URL).toString();
  const isValid = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, req.body ?? {});

  if (!isValid) {
    logger.warn('twilio.signature.rejected', { url, ip: req.ip });
    return next(forbidden('Invalid Twilio signature'));
  }

  return next();
}
