import { supabase, rpc, assertNoDbError } from '../config/supabase.js';
import { logger, errorMeta } from '../utils/logger.js';

/**
 * Conversational state, persisted in Postgres.
 *
 * A WhatsApp location pin and a prescription photo arrive as two separate
 * messages, in whichever order the patient happens to send them. Holding that
 * state in a process-local Map would lose it on every restart and break across
 * multiple instances, so patient_sessions is the source of truth.
 */

/** Stores (or refreshes) the patient's pin. */
export async function savePatientLocation(phoneNumber, lat, lon, label = null) {
  const session = await rpc('upsert_patient_location', {
    p_phone_number: phoneNumber,
    p_lat: lat,
    p_lon: lon,
    p_label: label,
  });

  logger.info('session.location_saved', { phone: phoneNumber, lat, lon });
  return session;
}

/** Returns the session, or null if this number has never messaged us. */
export async function getPatientSession(phoneNumber) {
  const session = await rpc('get_patient_session', { p_phone_number: phoneNumber });
  return session?.found ? session : null;
}

/** Parks a photo that arrived before we had a location to route it with. */
export async function setPendingMedia(phoneNumber, mediaUrl, contentType = null) {
  await rpc('set_pending_media', {
    p_phone_number: phoneNumber,
    p_media_url: mediaUrl,
    p_content_type: contentType,
  });

  logger.info('session.media_parked', { phone: phoneNumber });
}

/** Clears the parked photo once it has been processed. */
export async function clearPendingMedia(phoneNumber) {
  const { error } = await supabase
    .from('patient_sessions')
    .update({ pending_media_url: null, pending_media_content_type: null })
    .eq('phone_number', phoneNumber);

  assertNoDbError(error, 'clearPendingMedia');
}

/** Bumps last_inbound_at. Best-effort: never blocks message handling. */
export async function touchSession(phoneNumber) {
  try {
    const { error } = await supabase
      .from('patient_sessions')
      .upsert(
        { phone_number: phoneNumber, last_inbound_at: new Date().toISOString() },
        { onConflict: 'phone_number' },
      );
    assertNoDbError(error, 'touchSession');
  } catch (error) {
    logger.warn('session.touch_failed', { phone: phoneNumber, ...errorMeta(error) });
  }
}

/**
 * Records the inbound webhook and reports whether we have seen this MessageSid
 * before. Twilio retries webhooks it considers failed; without this check a
 * retry would re-run AI vision and re-broadcast the same prescription.
 */
export async function registerInboundMessage(payload) {
  const result = await rpc('register_inbound_message', {
    p_message_sid: payload.MessageSid ?? payload.SmsMessageSid ?? `missing-sid-${Date.now()}`,
    p_from: payload.From ?? null,
    p_to: payload.To ?? null,
    p_body: payload.Body ?? null,
    p_num_media: Number.parseInt(payload.NumMedia ?? '0', 10) || 0,
    p_raw: payload,
  });

  return { duplicate: Boolean(result?.duplicate), id: result?.id ?? null };
}

/** Annotates a logged message with the outcome of processing it. */
export async function noteMessageProcessed(messageSid, note) {
  try {
    const { error } = await supabase
      .from('whatsapp_messages')
      .update({ processed_at: new Date().toISOString(), processing_note: note })
      .eq('message_sid', messageSid);

    assertNoDbError(error, 'noteMessageProcessed');
  } catch (error) {
    logger.warn('message_log.note_failed', { messageSid, ...errorMeta(error) });
  }
}
