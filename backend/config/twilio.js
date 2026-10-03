import twilio from 'twilio';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/** Twilio REST client used for every outbound WhatsApp message. */
export const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

export const WHATSAPP_FROM = env.TWILIO_WHATSAPP_NUMBER;

/** Basic auth header for fetching media off the Twilio API. */
export const twilioBasicAuthHeader =
  'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

const VERIFY_TIMEOUT_MS = 5000;

/**
 * Confirms the credentials are valid and the account is reachable.
 *
 * Non-fatal — the server still boots, because Twilio being briefly unreachable
 * should not stop the REST API or the dashboard from serving. Bounded by a
 * timeout so a Twilio outage delays startup by five seconds, not by however
 * long the SDK's own retry chain takes.
 */
export async function verifyTwilioCredentials() {
  try {
    const account = await Promise.race([
      twilioClient.api.v2010.accounts(env.TWILIO_ACCOUNT_SID).fetch(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Twilio did not respond within ${VERIFY_TIMEOUT_MS} ms`)), VERIFY_TIMEOUT_MS).unref(),
      ),
    ]);
    logger.info('twilio.connected', {
      friendlyName: account.friendlyName,
      status: account.status,
      from: WHATSAPP_FROM,
    });
    return true;
  } catch (error) {
    logger.warn('twilio.verification_failed', {
      message: error.message,
      code: error.code,
      hint: 'Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. Outbound WhatsApp messages will fail until this is fixed.',
    });
    return false;
  }
}
