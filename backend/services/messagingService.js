import { twilioClient, WHATSAPP_FROM } from '../config/twilio.js';
import { supabase } from '../config/supabase.js';
import { logger, errorMeta } from '../utils/logger.js';
import {
  formatDistance,
  formatDrugList,
  formatDrugLines,
  googleMapsDirectionsUrl,
  googleMapsPinUrl,
  displayPhone,
} from '../utils/format.js';

/**
 * Outbound WhatsApp messaging.
 *
 * sendWhatsapp never throws: a failed send to one of five pharmacies must not
 * abort the other four, and a failed courtesy reply must not roll back a
 * successful claim. The outcome is returned and logged instead.
 */

/**
 * @returns {Promise<{ok: boolean, sid: string|null, status: string|null, error: string|null, code: number|null, to: string}>}
 */
export async function sendWhatsapp(to, body) {
  if (!to || !body) {
    return { ok: false, sid: null, status: null, error: 'Missing recipient or body', code: null, to };
  }

  try {
    const message = await twilioClient.messages.create({ from: WHATSAPP_FROM, to, body });

    logger.info('twilio.sent', { to: displayPhone(to), sid: message.sid, status: message.status });

    await logOutbound({ sid: message.sid, to, body, status: message.status });

    return { ok: true, sid: message.sid, status: message.status, error: null, code: null, to };
  } catch (error) {
    logger.error('twilio.send_failed', { to: displayPhone(to), ...errorMeta(error) });

    await logOutbound({ sid: null, to, body, status: 'failed', error: error.message });

    return { ok: false, sid: null, status: 'failed', error: error.message, code: error.code ?? null, to };
  }
}

/** Fans out one body to many recipients concurrently. */
export async function sendWhatsappBatch(recipients) {
  return Promise.all(recipients.map(({ to, body }) => sendWhatsapp(to, body)));
}

/**
 * Appends to the message audit trail. Best-effort: a logging failure is not
 * allowed to surface as a messaging failure.
 */
async function logOutbound({ sid, to, body, status, error }) {
  try {
    await supabase.from('whatsapp_messages').insert({
      message_sid: sid ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      direction: 'outbound',
      from_number: WHATSAPP_FROM,
      to_number: to,
      body,
      processed_at: new Date().toISOString(),
      processing_note: error ? `send_failed: ${error}` : `status=${status}`,
    });
  } catch (dbError) {
    logger.warn('message_log.insert_failed', errorMeta(dbError));
  }
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/** The broadcast every nearby pharmacy receives. */
export function buildBroadcastMessage({ shortCode, drugs, distanceMeters }) {
  return (
    `🚨 NEW PRESCRIPTION REQUEST [Ref: ${shortCode}]\n` +
    `Drug Needed: ${formatDrugList(drugs)}\n` +
    `Distance: ${formatDistance(distanceMeters)} away.\n\n` +
    `Reply 'YES-${shortCode}' immediately to claim this order.`
  );
}

/** Sent to the pharmacy that won the race. */
export function buildClaimWonMessage({ shortCode, drugs, patientPhone, patientLat, patientLon }) {
  const lines = [
    `✅ Order claimed! [Ref: ${shortCode}]`,
    '',
    'Please prepare:',
    formatDrugLines(drugs),
    '',
    `Patient contact: ${displayPhone(patientPhone)}`,
  ];

  if (Number.isFinite(patientLat) && Number.isFinite(patientLon)) {
    lines.push(`Patient location: ${googleMapsPinUrl(patientLat, patientLon)}`);
  }

  lines.push('', 'The patient has been notified and is on the way.');
  return lines.join('\n');
}

/** Sent to every pharmacy that replied too late. */
export function buildClaimLostMessage(shortCode) {
  return `Sorry, this prescription was already claimed by another nearby pharmacy. [Ref: ${shortCode}]`;
}

/** Sent to the patient once a pharmacy commits. */
export function buildPatientClaimedMessage({ pharmacy, drugs, patientLat, patientLon, shortCode }) {
  const directions = googleMapsDirectionsUrl({
    fromLat: patientLat,
    fromLon: patientLon,
    toLat: pharmacy.latitude,
    toLon: pharmacy.longitude,
  });

  const lines = [
    `🎉 Good news! ${pharmacy.name} has claimed your prescription and is preparing it now.`,
    '',
    `Medication: ${formatDrugList(drugs)}`,
  ];

  if (pharmacy.address) lines.push(`Address: ${pharmacy.address}`);
  if (Number.isFinite(pharmacy.distance_meters)) {
    lines.push(`Distance: ${formatDistance(pharmacy.distance_meters)} from you`);
  }
  lines.push(`Pharmacy contact: ${displayPhone(pharmacy.phone_number)}`);
  lines.push('', `Directions: ${directions}`, '', `Your reference: ${shortCode}`);

  return lines.join('\n');
}

/** Confirms a prescription was understood and dispatched. */
export function buildPatientBroadcastMessage({ shortCode, drugs, pharmacyCount, widened, radiusMeters }) {
  const lines = [
    '✅ Prescription received and verified.',
    '',
    `Medication: ${formatDrugList(drugs)}`,
    `Reference: ${shortCode}`,
    '',
    `Sent to ${pharmacyCount} nearby ${pharmacyCount === 1 ? 'pharmacy' : 'pharmacies'}.`,
  ];

  if (widened) {
    lines.push(`(No pharmacy was within the usual range, so we searched up to ${formatDistance(radiusMeters)}.)`);
  }

  lines.push('', "We'll message you the moment one of them claims it.");
  return lines.join('\n');
}

export function buildLocationSavedMessage({ hasPendingMedia }) {
  return hasPendingMedia
    ? '📍 Location saved. Processing the prescription you sent earlier…'
    : '📍 Location saved. Now send a clear photo of your prescription.';
}

export function buildLocationNeededMessage() {
  return (
    '📍 We have your prescription photo, but we need your location to find nearby pharmacies.\n\n' +
    'Tap 📎 (attach) → Location → Send your current location.\n\n' +
    "As soon as it arrives we'll process the photo automatically — no need to resend it."
  );
}

export function buildInvalidPrescriptionMessage(reason) {
  return (
    `❌ We could not read that as a valid prescription.\n\n` +
    `Reason: ${reason || 'The image is not a readable medical prescription.'}\n\n` +
    'Please send a clear, well-lit photo of the full prescription — all four corners visible, no glare.'
  );
}

export function buildNoPharmaciesMessage(radiusMeters) {
  return (
    `😔 We could not find any pharmacy registered with RxRoute within ${formatDistance(radiusMeters)} of you.\n\n` +
    'Your request has been logged. Try again from a different location, or contact your hospital pharmacy directly.'
  );
}

export function buildProcessingErrorMessage() {
  return (
    '⚠️ Something went wrong while processing your prescription.\n\n' +
    'Nothing was sent to any pharmacy. Please try sending the photo again in a moment.'
  );
}

export function buildUnknownPharmacyMessage() {
  return (
    'This number is not registered as an RxRoute pharmacy, so it cannot claim orders.\n\n' +
    'If you are a pharmacy and would like to join, please contact the RxRoute team.'
  );
}

export function buildNotBroadcastMessage(shortCode) {
  return `Reference ${shortCode} was not sent to your pharmacy, so it cannot be claimed here.`;
}

export function buildUnknownReferenceMessage(shortCode) {
  return `We could not find a prescription with reference ${shortCode}. Please check the reference and try again.`;
}

export function buildExpiredReferenceMessage(shortCode) {
  return `Reference ${shortCode} has expired and is no longer available to claim.`;
}

/** Reply to "STATUS RX0001". */
export function buildStatusMessage(detail) {
  const lines = [`Reference ${detail.short_code} — status: ${detail.status.toUpperCase()}`];

  lines.push(`Medication: ${formatDrugList(detail.extracted_drugs)}`);

  if (detail.status === 'claimed' && detail.claimed_by) {
    lines.push(`Claimed by: ${detail.claimed_by.name}`);
    if (detail.claimed_by.address) lines.push(`Address: ${detail.claimed_by.address}`);
    lines.push(`Contact: ${displayPhone(detail.claimed_by.phone_number)}`);
  } else if (detail.status === 'pending') {
    lines.push(`Sent to ${detail.broadcast_count} ${detail.broadcast_count === 1 ? 'pharmacy' : 'pharmacies'}; awaiting a claim.`);
  } else if (detail.failure_reason) {
    lines.push(`Note: ${detail.failure_reason}`);
  }

  return lines.join('\n');
}

export function buildHelpMessage() {
  return (
    '👋 *Welcome to RxRoute* — prescriptions routed to the nearest pharmacy.\n\n' +
    '*Patients:*\n' +
    '1️⃣ Send your location (📎 → Location)\n' +
    '2️⃣ Send a clear photo of your prescription\n' +
    "3️⃣ We'll verify it and alert the 5 nearest pharmacies\n" +
    '4️⃣ The first to claim it prepares your medication\n\n' +
    '*Pharmacies:*\n' +
    "Reply 'YES-<REF>' to claim a broadcast order.\n\n" +
    "Send 'STATUS <REF>' any time to check a request."
  );
}

export function buildFallbackMessage() {
  return (
    "I didn't quite catch that.\n\n" +
    'Send a *photo* of your prescription plus your *location* to get started, or reply HELP for instructions.'
  );
}
