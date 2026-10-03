import { z } from 'zod';
import { env } from '../config/env.js';
import {
  processPrescription,
  claimPrescription,
  listPrescriptions,
  getPrescriptionDetail,
  getBroadcastsForRequest,
  rebroadcastPrescription,
  expireStalePrescriptions,
} from '../services/prescriptionService.js';
import { normaliseWhatsappNumber } from '../utils/format.js';
import { conflict, notFound, badRequest } from '../utils/httpError.js';

const phoneNumber = z
  .string()
  .min(7)
  .transform((value, ctx) => {
    const normalised = normaliseWhatsappNumber(value);
    if (!normalised) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" is not a usable phone number.` });
      return z.NEVER;
    }
    return normalised;
  });

const listSchema = z.object({
  status: z.enum(['pending', 'claimed', 'expired', 'failed']).optional(),
  patient_phone: phoneNumber.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ingestSchema = z.object({
  patient_phone: phoneNumber,
  media_url: z.string().url('media_url must be a fetchable URL'),
  content_type: z.string().max(120).optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  notify_patient: z.boolean().optional().default(true),
});

const claimSchema = z.object({
  pharmacy_phone: phoneNumber,
  notify: z.boolean().optional().default(true),
});

const rebroadcastSchema = z.object({
  radius_meters: z.coerce.number().positive().max(500_000).optional(),
});

const expireSchema = z.object({
  older_than_minutes: z.coerce.number().int().min(1).max(10_080).default(env.REQUEST_EXPIRY_MINUTES),
});

/** GET /api/prescriptions */
export async function index(req, res) {
  const { status, patient_phone: patientPhone, limit, offset } = listSchema.parse(req.query);

  const result = await listPrescriptions({ status: status ?? null, patientPhone: patientPhone ?? null, limit, offset });

  res.json({ data: result.prescriptions, meta: { total: result.total, limit, offset } });
}

/** GET /api/prescriptions/:idOrCode — accepts a UUID or a short code (RX0001). */
export async function show(req, res) {
  res.json({ data: await getPrescriptionDetail(req.params.idOrCode) });
}

/** GET /api/prescriptions/:idOrCode/broadcasts */
export async function broadcasts(req, res) {
  const detail = await getPrescriptionDetail(req.params.idOrCode);
  const rows = await getBroadcastsForRequest(detail.id);

  res.json({ data: rows, meta: { short_code: detail.short_code, count: rows.length } });
}

/**
 * POST /api/prescriptions
 *
 * Runs the identical pipeline the WhatsApp webhook runs — real media download,
 * real Gemini vision, real PostGIS match, real Twilio broadcast. This is the
 * endpoint to drive from a dashboard or an integration test; it is not a
 * simulation path.
 */
export async function ingest(req, res) {
  const payload = ingestSchema.parse(req.body);

  const result = await processPrescription({
    patientPhone: payload.patient_phone,
    mediaUrl: payload.media_url,
    contentType: payload.content_type ?? null,
    lat: payload.latitude,
    lon: payload.longitude,
    notifyPatient: payload.notify_patient,
  });

  const status = result.outcome === 'broadcast' ? 201 : 200;

  res.status(status).json({
    data: {
      outcome: result.outcome,
      request: result.request,
      analysis: {
        valid: result.analysis.valid,
        drugs: result.analysis.drugs,
        reason: result.analysis.reason,
        confidence: result.analysis.confidence,
        model: result.analysis.model,
      },
      pharmacies: result.pharmacies,
      delivered: result.delivered,
    },
  });
}

/**
 * POST /api/prescriptions/:idOrCode/claim
 *
 * The same first-come-first-served path a "YES-RX0001" WhatsApp reply takes,
 * including the row lock. Fire this concurrently against one reference to see
 * exactly one 200 and the rest 409.
 */
export async function claim(req, res) {
  const { pharmacy_phone: pharmacyPhone, notify } = claimSchema.parse(req.body);

  // Resolve a UUID to its short code; the claim RPC is keyed on the short code.
  const detail = await getPrescriptionDetail(req.params.idOrCode);

  const outcome = await claimPrescription({
    shortCode: detail.short_code,
    pharmacyPhone,
    notify,
  });

  switch (outcome.result) {
    case 'claimed':
      return res.json({
        data: {
          result: 'claimed',
          short_code: outcome.request.short_code,
          claimed_at: outcome.request.claimed_at,
          pharmacy: outcome.pharmacy,
          request: outcome.request,
        },
      });

    case 'already_claimed':
      throw conflict(`Prescription ${outcome.shortCode} was already claimed by ${outcome.winner?.name ?? 'another pharmacy'}.`, {
        result: outcome.result,
        winner: outcome.winner,
        claimed_at: outcome.claimed_at,
      });

    case 'unknown_pharmacy':
      throw notFound(`No active pharmacy is registered with the number ${pharmacyPhone}.`);

    case 'not_broadcast':
      throw conflict(`Prescription ${outcome.shortCode} was not broadcast to ${pharmacyPhone}, so it cannot be claimed.`, {
        result: outcome.result,
        hint: 'Set CLAIM_REQUIRES_BROADCAST=false to allow any pharmacy to claim any request.',
      });

    case 'not_found':
      throw notFound(`No prescription with reference ${outcome.shortCode}.`);

    default:
      throw conflict(`Prescription ${outcome.shortCode} is not claimable (status: ${outcome.status ?? outcome.result}).`, {
        result: outcome.result,
      });
  }
}

/** POST /api/prescriptions/:idOrCode/rebroadcast */
export async function rebroadcast(req, res) {
  const { radius_meters: radiusMeters } = rebroadcastSchema.parse(req.body ?? {});

  const result = await rebroadcastPrescription(req.params.idOrCode, { radiusMeters: radiusMeters ?? null });

  if (result.outcome === 'no_pharmacies') {
    throw badRequest(
      `No active pharmacy found within ${Math.round(result.radiusMeters)} m of request ${result.shortCode}.`,
      { result },
    );
  }

  res.json({ data: result });
}

/** POST /api/prescriptions/expire-stale */
export async function expireStale(req, res) {
  const { older_than_minutes: olderThanMinutes } = expireSchema.parse(req.body ?? {});
  res.json({ data: await expireStalePrescriptions(olderThanMinutes) });
}
