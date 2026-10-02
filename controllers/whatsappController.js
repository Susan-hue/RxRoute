import { env } from '../config/env.js';
import { logger, errorMeta } from '../utils/logger.js';
import {
  parseClaimCommand,
  parseStatusCommand,
  isHelpCommand,
  toFiniteNumber,
  isValidCoordinate,
} from '../utils/format.js';
import {
  savePatientLocation,
  getPatientSession,
  setPendingMedia,
  clearPendingMedia,
  touchSession,
  registerInboundMessage,
  noteMessageProcessed,
} from '../services/sessionService.js';
import {
  processPrescription,
  claimPrescription,
  findPrescriptionDetail,
  recordDeliveryStatus,
  resolveSenderPharmacy,
} from '../services/prescriptionService.js';
import {
  sendWhatsapp,
  buildLocationSavedMessage,
  buildLocationNeededMessage,
  buildProcessingErrorMessage,
  buildUnknownPharmacyMessage,
  buildNotBroadcastMessage,
  buildUnknownReferenceMessage,
  buildExpiredReferenceMessage,
  buildStatusMessage,
  buildHelpMessage,
  buildFallbackMessage,
} from '../services/messagingService.js';

/**
 * Twilio WhatsApp webhook — the conversational state machine.
 *
 * Twilio abandons a webhook after 15 seconds. A prescription takes a media
 * download plus a Gemini vision call plus five outbound sends, which routinely
 * exceeds that. So the webhook acknowledges immediately with empty TwiML and
 * continues the work in the background, replying over the REST API. Set
 * WEBHOOK_ASYNC=false to process inline (useful when testing with curl).
 */

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function handleIncomingWhatsapp(req, res) {
  const payload = req.body ?? {};
  const messageSid = payload.MessageSid ?? payload.SmsMessageSid ?? null;

  logger.info('webhook.received', {
    sid: messageSid,
    from: payload.From,
    numMedia: payload.NumMedia,
    hasLocation: Boolean(payload.Latitude && payload.Longitude),
    bodyPreview: (payload.Body ?? '').slice(0, 60),
  });

  if (!payload.From) {
    // Not a message webhook we understand; ack so Twilio stops retrying.
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
  }

  if (env.WEBHOOK_ASYNC) {
    res.type('text/xml').status(200).send(EMPTY_TWIML);

    // Detached on purpose: errors are handled inside, so this can never become
    // an unhandled rejection or try to write to an already-sent response.
    processInboundMessage(payload).catch((error) => {
      logger.error('webhook.background_failure', { sid: messageSid, ...errorMeta(error) });
    });
    return;
  }

  try {
    const result = await processInboundMessage(payload);
    res.type('text/xml').status(200).set('X-RxRoute-Action', result?.action ?? 'none').send(EMPTY_TWIML);
  } catch (error) {
    logger.error('webhook.sync_failure', { sid: messageSid, ...errorMeta(error) });
    // Still a 200: a non-2xx makes Twilio retry, which would duplicate work.
    res.type('text/xml').status(200).send(EMPTY_TWIML);
  }
}

/**
 * Routes one inbound message. Returns `{ action }` describing what it did,
 * which the sync path surfaces as a header and tests assert on.
 */
export async function processInboundMessage(payload) {
  const from = payload.From;
  const body = payload.Body ?? '';
  const numMedia = Number.parseInt(payload.NumMedia ?? '0', 10) || 0;
  const latitude = toFiniteNumber(payload.Latitude);
  const longitude = toFiniteNumber(payload.Longitude);
  const hasLocation = isValidCoordinate(latitude, longitude);

  // Idempotency gate — Twilio retries webhooks it believes failed.
  const { duplicate } = await registerInboundMessage(payload);
  if (duplicate) {
    logger.info('webhook.duplicate_ignored', { sid: payload.MessageSid, from });
    return { action: 'duplicate_ignored' };
  }

  const sid = payload.MessageSid ?? payload.SmsMessageSid;

  try {
    const action = await route({ from, body, numMedia, payload, latitude, longitude, hasLocation });
    await noteMessageProcessed(sid, action);
    return { action };
  } catch (error) {
    logger.error('webhook.processing_failed', { from, sid, ...errorMeta(error) });
    await noteMessageProcessed(sid, `error: ${error.message}`.slice(0, 500));

    // Tell the sender something went wrong rather than leaving them waiting.
    await sendWhatsapp(from, buildProcessingErrorMessage());
    return { action: 'error' };
  }
}

async function route({ from, body, numMedia, payload, latitude, longitude, hasLocation }) {
  // 1. A claim reply from a pharmacy: "YES-RX0001".
  const claimCode = parseClaimCommand(body);
  if (claimCode) {
    return handleClaim({ from, shortCode: claimCode });
  }

  // 2. "STATUS RX0001".
  const statusCode = parseStatusCommand(body);
  if (statusCode) {
    return handleStatus({ from, shortCode: statusCode });
  }

  // 3. A location pin — on its own, or attached to the same message as a photo.
  if (hasLocation) {
    return handleLocation({ from, latitude, longitude, payload, numMedia });
  }

  // 4. A prescription photo.
  if (numMedia > 0) {
    return handleMedia({ from, payload });
  }

  // 5. Plain text.
  await touchSession(from);

  if (isHelpCommand(body)) {
    await sendWhatsapp(from, buildHelpMessage());
    return 'help';
  }

  await sendWhatsapp(from, buildFallbackMessage());
  return 'fallback';
}

// ---------------------------------------------------------------------------
// Workflow A — location, then photo (in either order)
// ---------------------------------------------------------------------------

async function handleLocation({ from, latitude, longitude, payload, numMedia }) {
  const label = payload.Address ?? payload.Label ?? null;
  await savePatientLocation(from, latitude, longitude, label);

  // A photo in the *same* message: process it straight away.
  if (numMedia > 0 && payload.MediaUrl0) {
    await runPipeline({
      from,
      mediaUrl: payload.MediaUrl0,
      contentType: payload.MediaContentType0,
      lat: latitude,
      lon: longitude,
    });
    return 'location_and_media';
  }

  // A photo parked by an earlier message: resume it now.
  const session = await getPatientSession(from);
  if (session?.pending_media_url) {
    await sendWhatsapp(from, buildLocationSavedMessage({ hasPendingMedia: true }));
    await clearPendingMedia(from);
    await runPipeline({
      from,
      mediaUrl: session.pending_media_url,
      contentType: session.pending_media_content_type,
      lat: latitude,
      lon: longitude,
    });
    return 'location_resumed_media';
  }

  await sendWhatsapp(from, buildLocationSavedMessage({ hasPendingMedia: false }));
  return 'location_saved';
}

async function handleMedia({ from, payload }) {
  const mediaUrl = payload.MediaUrl0;
  const contentType = payload.MediaContentType0 ?? null;

  if (!mediaUrl) {
    await sendWhatsapp(from, buildFallbackMessage());
    return 'media_missing_url';
  }

  const session = await getPatientSession(from);

  // No location yet: park the photo and ask for a pin. Twilio retains the media,
  // so the patient will not have to resend it.
  if (!session || !isValidCoordinate(session.latitude, session.longitude)) {
    await setPendingMedia(from, mediaUrl, contentType);
    await sendWhatsapp(from, buildLocationNeededMessage());
    return 'awaiting_location';
  }

  await runPipeline({
    from,
    mediaUrl,
    contentType,
    lat: session.latitude,
    lon: session.longitude,
  });

  return 'prescription_processed';
}

/**
 * Invokes the pipeline. processPrescription() already notifies the patient on
 * every expected outcome; this only has to catch genuine infrastructure
 * failures (Gemini down, Twilio media gone) and tell the patient.
 */
async function runPipeline({ from, mediaUrl, contentType, lat, lon }) {
  try {
    const result = await processPrescription({
      patientPhone: from,
      mediaUrl,
      contentType,
      lat,
      lon,
      notifyPatient: true,
    });
    return result.outcome;
  } catch (error) {
    logger.error('pipeline.failed', { from, ...errorMeta(error) });

    // badRequest-level problems (wrong attachment type, oversized image) carry a
    // message that is genuinely useful to the sender; anything else is internal.
    const message = error.status === 400 ? `⚠️ ${error.message}` : buildProcessingErrorMessage();
    await sendWhatsapp(from, message);
    return 'pipeline_error';
  }
}

// ---------------------------------------------------------------------------
// Workflow B — claiming
// ---------------------------------------------------------------------------

async function handleClaim({ from, shortCode }) {
  const outcome = await claimPrescription({ shortCode, pharmacyPhone: from, notify: true });

  switch (outcome.result) {
    case 'claimed':
      // claimPrescription already messaged both the pharmacy and the patient.
      return 'claim_won';

    case 'already_claimed':
      // claimPrescription already sent the "too late" reply.
      return 'claim_lost';

    case 'unknown_pharmacy': {
      // Could be a patient echoing the reference back, so check before
      // telling them they are not a registered pharmacy.
      const pharmacy = await resolveSenderPharmacy(from);
      if (!pharmacy) await sendWhatsapp(from, buildUnknownPharmacyMessage());
      return 'claim_unknown_pharmacy';
    }

    case 'not_broadcast':
      await sendWhatsapp(from, buildNotBroadcastMessage(shortCode));
      return 'claim_not_broadcast';

    case 'expired':
      await sendWhatsapp(from, buildExpiredReferenceMessage(shortCode));
      return 'claim_expired';

    case 'not_found':
      await sendWhatsapp(from, buildUnknownReferenceMessage(shortCode));
      return 'claim_not_found';

    default:
      await sendWhatsapp(
        from,
        `Reference ${shortCode} is no longer available to claim (status: ${outcome.status ?? 'unknown'}).`,
      );
      return 'claim_not_claimable';
  }
}

async function handleStatus({ from, shortCode }) {
  const detail = await findPrescriptionDetail(shortCode);

  if (!detail) {
    await sendWhatsapp(from, buildUnknownReferenceMessage(shortCode));
    return 'status_not_found';
  }

  // Only the patient who submitted it or a pharmacy it was broadcast to may
  // read a prescription's contents.
  const isPatient = detail.patient_phone === from;
  const isRecipient = (detail.broadcasts ?? []).some((b) => b.phone_number === from);

  if (!isPatient && !isRecipient) {
    await sendWhatsapp(from, buildNotBroadcastMessage(shortCode));
    return 'status_forbidden';
  }

  await sendWhatsapp(from, buildStatusMessage(detail));
  return 'status_sent';
}

// ---------------------------------------------------------------------------
// Twilio delivery status callback
// ---------------------------------------------------------------------------

export async function handleStatusCallback(req, res) {
  const { MessageSid, MessageStatus, ErrorCode } = req.body ?? {};

  logger.debug('twilio.status_callback', { sid: MessageSid, status: MessageStatus, errorCode: ErrorCode });

  try {
    await recordDeliveryStatus({ messageSid: MessageSid, status: MessageStatus, errorCode: ErrorCode });
  } catch (error) {
    logger.warn('twilio.status_callback_failed', errorMeta(error));
  }

  res.status(204).end();
}
