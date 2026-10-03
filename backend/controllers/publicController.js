import { createHash } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { env, isProduction } from '../config/env.js';
import { processPrescription, getPrescriptionDetail } from '../services/prescriptionService.js';
import { prepareUploadedImage } from '../services/mediaService.js';
import { normaliseWhatsappNumber, displayPhone } from '../utils/format.js';
import { badRequest } from '../utils/httpError.js';
import { logger, errorMeta } from '../utils/logger.js';

/**
 * The unauthenticated endpoints behind the patient web app.
 *
 * These deliberately return less than /api/prescriptions: no patient phone
 * numbers, no raw AI output, and a pharmacy's phone number only once it has
 * accepted the request.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_MEDIA_BYTES, files: 1, fields: 10 },
});

/** multer's own errors (oversized file, wrong field name) as clean 400s. */
export function receivePhoto(req, res, next) {
  upload.single('photo')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `That photo is over the ${Math.round(env.MAX_MEDIA_BYTES / (1024 * 1024))} MB limit. Try a smaller one.`
          : `Upload rejected: ${error.message}`;
      return next(badRequest(message));
    }
    return next(error);
  });
}

/**
 * The web form shows a fixed +234 prefix, so a national number here is
 * explicitly Nigerian rather than a guess: 0803…, 803… and 234803… all map to
 * +234803….
 */
const nigerianPhone = z
  .string()
  .trim()
  .min(1, 'Enter your phone number.')
  .transform((value, ctx) => {
    let digits = value.replace(/[\s()\-.]/g, '');

    if (digits.startsWith('+')) digits = digits.slice(1);
    else if (digits.startsWith('00')) digits = digits.slice(2);

    if (digits.startsWith('234')) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);

    const normalised = /^[1-9]\d{9}$/.test(digits) ? normaliseWhatsappNumber(`+234${digits}`) : null;
    if (!normalised) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.' });
      return z.NEVER;
    }
    return normalised;
  });

const createSchema = z.object({
  phone: nigerianPhone,
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

const idSchema = z.object({ id: z.string().uuid('Not a valid request id.') });

function toPublicResult(result) {
  return {
    outcome: result.outcome,
    request: result.request
      ? { id: result.request.id, short_code: result.request.short_code, status: result.request.status }
      : null,
    drugs: result.analysis.drugs,
    reason: result.analysis.reason,
    radius_meters: result.radiusMeters,
    delivered: result.delivered,
    widened: result.widened,
    pharmacies: result.pharmacies.map((pharmacy) => ({
      id: pharmacy.id,
      name: pharmacy.name,
      address: pharmacy.address ?? null,
      distance_meters: pharmacy.distance_meters,
    })),
  };
}

/**
 * POST /api/public/prescriptions  (multipart: photo, phone, latitude, longitude)
 *
 * Validation failures are ordinary JSON errors. Once the pipeline starts, the
 * response is newline-delimited JSON so the page can show each real stage as
 * it happens:
 *   {"type":"stage","stage":"analyzing"}
 *   {"type":"stage","stage":"locating"}
 *   {"type":"stage","stage":"broadcasting"}
 *   {"type":"result","data":{…}}      or      {"type":"error","status":502,"message":"…"}
 */
export async function createPrescription(req, res) {
  const payload = createSchema.parse(req.body ?? {});
  if (!req.file) throw badRequest('Attach a photo of the prescription.');

  const media = prepareUploadedImage(req.file.buffer, req.file.mimetype);

  // media_url is NOT NULL and the image itself is not stored, so record a
  // fingerprint that identifies the upload without keeping it.
  const digest = createHash('sha256').update(media.buffer).digest('hex').slice(0, 16);

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event) => res.write(`${JSON.stringify(event)}\n`);

  try {
    const result = await processPrescription({
      patientPhone: payload.phone,
      mediaUrl: `upload:sha256-${digest}`,
      media,
      lat: payload.latitude,
      lon: payload.longitude,
      notifyPatient: false,
      detailedPharmacies: true,
      onStage: (stage) => send({ type: 'stage', stage }),
    });

    send({ type: 'result', data: toPublicResult(result) });
  } catch (error) {
    const status = error.status ?? error.statusCode ?? 500;

    if (status >= 500) logger.error('public.prescription_failed', errorMeta(error));
    else logger.warn('public.prescription_rejected', { status, message: error.message });

    send({
      type: 'error',
      status,
      message: status >= 500 && isProduction ? 'Something went wrong on our side. Please try again.' : error.message,
    });
  }

  res.end();
}

/** GET /api/public/prescriptions/:id — polled by the results page until a pharmacy accepts. */
export async function showPrescription(req, res) {
  const { id } = idSchema.parse(req.params);
  const detail = await getPrescriptionDetail(id);
  const winner = detail.claimed_by;

  res.set('Cache-Control', 'no-store').json({
    data: {
      id: detail.id,
      short_code: detail.short_code,
      status: detail.status,
      claimed_at: detail.claimed_at,
      claimed_by: winner
        ? {
            name: winner.name,
            address: winner.address,
            phone: displayPhone(winner.phone_number),
            latitude: winner.latitude,
            longitude: winner.longitude,
          }
        : null,
    },
  });
}
