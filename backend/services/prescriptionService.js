import { env } from '../config/env.js';
import { supabase, rpc, assertNoDbError } from '../config/supabase.js';
import { logger, errorMeta } from '../utils/logger.js';
import { notFound, badRequest } from '../utils/httpError.js';
import { isValidCoordinate } from '../utils/format.js';
import { downloadTwilioMedia } from './mediaService.js';
import { analysePrescriptionImage } from './aiService.js';
import { findNearbyPharmaciesWithFallback } from './geoService.js';
import { getPharmacyByPhone } from './pharmacyService.js';
import {
  sendWhatsapp,
  sendWhatsappBatch,
  buildBroadcastMessage,
  buildClaimWonMessage,
  buildClaimLostMessage,
  buildPatientClaimedMessage,
  buildPatientBroadcastMessage,
  buildInvalidPrescriptionMessage,
  buildNoPharmaciesMessage,
} from './messagingService.js';

/**
 * The prescription lifecycle: ingest → verify → geo-match → broadcast → claim.
 *
 * Shared by the WhatsApp webhook and the REST API, so both paths produce
 * identical database state. Nothing here is simulated — every step is a real
 * Twilio download, a real Gemini call, a real PostGIS query and a real insert.
 */

// ---------------------------------------------------------------------------
// Broadcast fan-out
// ---------------------------------------------------------------------------

/**
 * Writes the broadcast ledger, then sends the messages.
 *
 * Order matters: the ledger rows exist *before* the first Twilio message goes
 * out, because a fast pharmacy can reply "YES-RX0001" while we are still
 * sending to the other four — and claim_prescription_request() checks the
 * ledger to authorise the claim.
 */
async function broadcastToPharmacies({ request, pharmacies, drugs }) {
  const { error: ledgerError } = await supabase.from('prescription_broadcasts').upsert(
    pharmacies.map((pharmacy) => ({
      request_id: request.id,
      pharmacy_id: pharmacy.id,
      distance_meters: pharmacy.distance_meters,
      delivery_status: 'queued',
    })),
    { onConflict: 'request_id,pharmacy_id' },
  );

  assertNoDbError(ledgerError, 'broadcastToPharmacies.ledger');

  const results = await sendWhatsappBatch(
    pharmacies.map((pharmacy) => ({
      to: pharmacy.phone_number,
      body: buildBroadcastMessage({
        shortCode: request.short_code,
        drugs,
        distanceMeters: pharmacy.distance_meters,
      }),
    })),
  );

  // Record per-pharmacy delivery outcomes so a silent failure is visible in the
  // dashboard rather than looking like a pharmacy that chose not to respond.
  await Promise.all(
    pharmacies.map((pharmacy, index) => {
      const result = results[index];
      return supabase
        .from('prescription_broadcasts')
        .update({
          twilio_message_sid: result.sid,
          delivery_status: result.ok ? (result.status ?? 'sent') : 'failed',
          error_message: result.error,
        })
        .eq('request_id', request.id)
        .eq('pharmacy_id', pharmacy.id)
        .then(({ error }) => {
          if (error) logger.warn('broadcast.status_update_failed', { pharmacyId: pharmacy.id, message: error.message });
        });
    }),
  );

  const deliveredCount = results.filter((r) => r.ok).length;

  const { error: countError } = await supabase
    .from('prescription_requests')
    .update({ broadcast_count: pharmacies.length })
    .eq('id', request.id);

  if (countError) logger.warn('broadcast.count_update_failed', { message: countError.message });

  logger.info('broadcast.complete', {
    shortCode: request.short_code,
    targeted: pharmacies.length,
    delivered: deliveredCount,
  });

  return { results, deliveredCount };
}

// ---------------------------------------------------------------------------
// Workflow A — ingestion
// ---------------------------------------------------------------------------

/**
 * Runs a prescription photo through the full pipeline.
 *
 * @param {object}  args
 * @param {string}  args.patientPhone  whatsapp:+234…
 * @param {string}  args.mediaUrl      Twilio media URL, or an `upload:` reference when `media` is supplied.
 * @param {string}  [args.contentType]
 * @param {{buffer: Buffer, mimeType: string}} [args.media]  An image already in memory (web upload); skips the download.
 * @param {number}  args.lat
 * @param {number}  args.lon
 * @param {boolean} [args.notifyPatient=true]
 * @param {boolean} [args.detailedPharmacies=false]  Attach address and coordinates to each matched pharmacy.
 * @param {(stage: 'analyzing'|'locating'|'broadcasting') => void} [args.onStage]  Progress hook for the web app.
 * @returns {Promise<{outcome: string, request: object|null, analysis: object, pharmacies: Array, delivered: number, radiusMeters: number|null, widened: boolean}>}
 *          outcome ∈ 'broadcast' | 'invalid_prescription' | 'no_pharmacies'
 */
export async function processPrescription({
  patientPhone,
  mediaUrl,
  contentType = null,
  media = null,
  lat,
  lon,
  notifyPatient = true,
  detailedPharmacies = false,
  onStage = () => {},
}) {
  if (!patientPhone) throw badRequest('patientPhone is required');
  if (!mediaUrl) throw badRequest('mediaUrl is required');
  if (!isValidCoordinate(lat, lon)) {
    throw badRequest(`A valid patient location is required (got latitude=${lat}, longitude=${lon})`);
  }

  const startedAt = Date.now();
  logger.info('prescription.processing', { patientPhone, mediaUrl });

  // 1. Fetch the image from Twilio, unless the web app already uploaded it.
  const image = media ?? (await downloadTwilioMedia(mediaUrl, contentType));

  // 2. AI vision verdict.
  onStage('analyzing');
  const analysis = await analysePrescriptionImage(image.buffer, image.mimeType);

  // 3a. Rejected — persist the attempt so the failure is auditable, not silent.
  if (!analysis.valid) {
    const failed = await rpc('create_prescription_request', {
      p_patient_phone: patientPhone,
      p_media_url: mediaUrl,
      p_extracted_drugs: [],
      p_lat: lat,
      p_lon: lon,
      p_status: 'failed',
      p_failure_reason: analysis.reason,
      p_ai_raw: analysis.raw,
      p_content_type: image.mimeType,
    });

    logger.info('prescription.rejected', { shortCode: failed.short_code, reason: analysis.reason });

    if (notifyPatient) {
      await sendWhatsapp(patientPhone, buildInvalidPrescriptionMessage(analysis.reason));
    }

    return {
      outcome: 'invalid_prescription',
      request: failed,
      analysis,
      pharmacies: [],
      delivered: 0,
      radiusMeters: null,
      widened: false,
    };
  }

  // 3b. Accepted — create the pending request.
  const request = await rpc('create_prescription_request', {
    p_patient_phone: patientPhone,
    p_media_url: mediaUrl,
    p_extracted_drugs: analysis.drugs,
    p_lat: lat,
    p_lon: lon,
    p_status: 'pending',
    p_failure_reason: null,
    p_ai_raw: analysis.raw,
    p_content_type: image.mimeType,
  });

  // 4. PostGIS geo-match.
  onStage('locating');
  const { pharmacies, radiusMeters, widened } = await findNearbyPharmaciesWithFallback(lat, lon, {
    detailed: detailedPharmacies,
  });

  if (pharmacies.length === 0) {
    const { error } = await supabase
      .from('prescription_requests')
      .update({
        status: 'failed',
        failure_reason: `No active pharmacy within ${Math.round(radiusMeters)} m of the patient`,
      })
      .eq('id', request.id);

    if (error) logger.warn('prescription.no_pharmacy_update_failed', { message: error.message });

    logger.warn('prescription.no_pharmacies', { shortCode: request.short_code, lat, lon, radiusMeters });

    if (notifyPatient) {
      await sendWhatsapp(patientPhone, buildNoPharmaciesMessage(radiusMeters));
    }

    return { outcome: 'no_pharmacies', request, analysis, pharmacies: [], delivered: 0, radiusMeters, widened };
  }

  // 5. Broadcast.
  onStage('broadcasting');
  const { deliveredCount } = await broadcastToPharmacies({ request, pharmacies, drugs: analysis.drugs });

  if (notifyPatient) {
    await sendWhatsapp(
      patientPhone,
      buildPatientBroadcastMessage({
        shortCode: request.short_code,
        drugs: analysis.drugs,
        pharmacyCount: pharmacies.length,
        widened,
        radiusMeters,
      }),
    );
  }

  logger.info('prescription.broadcast', {
    shortCode: request.short_code,
    pharmacies: pharmacies.length,
    delivered: deliveredCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    outcome: 'broadcast',
    request: { ...request, broadcast_count: pharmacies.length },
    analysis,
    pharmacies,
    delivered: deliveredCount,
    radiusMeters,
    widened,
  };
}

// ---------------------------------------------------------------------------
// Workflow B — claiming
// ---------------------------------------------------------------------------

/**
 * Attempts a claim. The winner/loser decision is made inside Postgres by
 * claim_prescription_request(), which takes a row lock — so two pharmacies
 * replying simultaneously cannot both succeed.
 *
 * @returns {Promise<{result: string, shortCode: string, request?: object, pharmacy?: object, winner?: object}>}
 *          result ∈ 'claimed' | 'already_claimed' | 'not_found' | 'unknown_pharmacy' | 'not_broadcast' | 'expired' | 'not_claimable'
 */
export async function claimPrescription({ shortCode, pharmacyPhone, notify = true }) {
  const code = (shortCode ?? '').trim().toUpperCase();
  if (!code) throw badRequest('shortCode is required');
  if (!pharmacyPhone) throw badRequest('pharmacyPhone is required');

  const outcome = await rpc('claim_prescription_request', {
    p_short_code: code,
    p_pharmacy_phone: pharmacyPhone,
    p_require_broadcast: env.CLAIM_REQUIRES_BROADCAST,
  });

  logger.info('claim.attempt', { shortCode: code, pharmacyPhone, result: outcome?.result });

  if (outcome?.result === 'claimed' && notify) {
    const { request, pharmacy } = outcome;

    // Both notifications are sent in parallel; sendWhatsapp never throws, so a
    // failure to reach one party still leaves the claim committed and logged.
    await Promise.all([
      sendWhatsapp(
        pharmacy.phone_number,
        buildClaimWonMessage({
          shortCode: request.short_code,
          drugs: request.extracted_drugs,
          patientPhone: request.patient_phone,
          patientLat: request.latitude,
          patientLon: request.longitude,
        }),
      ),
      sendWhatsapp(
        request.patient_phone,
        buildPatientClaimedMessage({
          pharmacy,
          drugs: request.extracted_drugs,
          patientLat: request.latitude,
          patientLon: request.longitude,
          shortCode: request.short_code,
        }),
      ),
    ]);
  }

  if (outcome?.result === 'already_claimed' && notify) {
    await sendWhatsapp(pharmacyPhone, buildClaimLostMessage(code));
  }

  return { ...outcome, shortCode: code };
}

// ---------------------------------------------------------------------------
// Reads and maintenance
// ---------------------------------------------------------------------------

export async function listPrescriptions({ status = null, patientPhone = null, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('prescription_requests_view')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (patientPhone) query = query.eq('patient_phone', patientPhone);

  const { data, error, count } = await query;
  assertNoDbError(error, 'listPrescriptions');

  return { prescriptions: data ?? [], total: count ?? 0, limit, offset };
}

/** Accepts either a UUID or a short code (RX0001). */
export async function getPrescriptionDetail(idOrCode) {
  const detail = await rpc('get_prescription_detail', { p_id_or_code: String(idOrCode) });

  if (!detail?.found) throw notFound(`No prescription matching "${idOrCode}"`);

  const { found, ...rest } = detail;
  return rest;
}

/** Soft lookup used by the WhatsApp STATUS command — null instead of throwing. */
export async function findPrescriptionDetail(idOrCode) {
  const detail = await rpc('get_prescription_detail', { p_id_or_code: String(idOrCode) });
  if (!detail?.found) return null;

  const { found, ...rest } = detail;
  return rest;
}

export async function getBroadcastsForRequest(requestId) {
  const { data, error } = await supabase
    .from('prescription_broadcasts')
    .select('*, pharmacy:pharmacies(id, name, phone_number, address)')
    .eq('request_id', requestId)
    .order('distance_meters', { ascending: true });

  assertNoDbError(error, 'getBroadcastsForRequest');
  return data ?? [];
}

/**
 * Re-runs the geo-match and broadcast for a still-pending request — useful when
 * every pharmacy in the first wave was offline. Re-uses the stored AI
 * extraction rather than paying for another vision call.
 */
export async function rebroadcastPrescription(idOrCode, { radiusMeters = null } = {}) {
  const detail = await getPrescriptionDetail(idOrCode);

  if (detail.status !== 'pending') {
    throw badRequest(`Cannot rebroadcast a request with status "${detail.status}" — only pending requests can be resent.`);
  }
  if (!isValidCoordinate(detail.latitude, detail.longitude)) {
    throw badRequest(`Request ${detail.short_code} has no stored patient location to search from.`);
  }

  const { pharmacies, radiusMeters: usedRadius } = await findNearbyPharmaciesWithFallback(
    detail.latitude,
    detail.longitude,
    { radiusMeters: radiusMeters ?? undefined },
  );

  if (pharmacies.length === 0) {
    return { outcome: 'no_pharmacies', shortCode: detail.short_code, radiusMeters: usedRadius, pharmacies: [], delivered: 0 };
  }

  const { deliveredCount } = await broadcastToPharmacies({
    request: { id: detail.id, short_code: detail.short_code },
    pharmacies,
    drugs: detail.extracted_drugs,
  });

  return {
    outcome: 'broadcast',
    shortCode: detail.short_code,
    radiusMeters: usedRadius,
    pharmacies,
    delivered: deliveredCount,
  };
}

/** Ages out pending requests nobody claimed. */
export async function expireStalePrescriptions(olderThanMinutes = env.REQUEST_EXPIRY_MINUTES) {
  const result = await rpc('expire_stale_prescription_requests', { p_older_than_minutes: olderThanMinutes });

  if ((result?.expired_count ?? 0) > 0) {
    logger.info('prescription.expired', { count: result.expired_count, shortCodes: result.short_codes });
  }

  return result;
}

/** Applies a Twilio status callback to the matching broadcast row. */
export async function recordDeliveryStatus({ messageSid, status, errorCode }) {
  if (!messageSid) return { updated: 0 };

  const { data, error } = await supabase
    .from('prescription_broadcasts')
    .update({
      delivery_status: status,
      error_message: errorCode ? `Twilio error ${errorCode}` : null,
    })
    .eq('twilio_message_sid', messageSid)
    .select('id');

  if (error) {
    logger.warn('delivery_status.update_failed', errorMeta(error));
    return { updated: 0 };
  }

  return { updated: data?.length ?? 0 };
}

/** True when the sender is a registered, active pharmacy. */
export async function resolveSenderPharmacy(phoneNumber) {
  return getPharmacyByPhone(phoneNumber);
}
