import { z } from 'zod';
import { env } from '../config/env.js';
import {
  listPharmacies,
  getPharmacyById,
  upsertPharmacy,
  updatePharmacy,
  deactivatePharmacy,
  deletePharmacy,
} from '../services/pharmacyService.js';
import { findNearbyPharmaciesDetailed } from '../services/geoService.js';
import { normaliseWhatsappNumber } from '../utils/format.js';
import { badRequest } from '../utils/httpError.js';

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

const phoneNumber = z
  .string()
  .min(7)
  .transform((value, ctx) => {
    const normalised = normaliseWhatsappNumber(value);
    if (!normalised) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${value}" is not a usable phone number. Use international format, e.g. +2348012345678.`,
      });
      return z.NEVER;
    }
    return normalised;
  });

const createSchema = z.object({
  name: z.string().trim().min(2, 'name must be at least 2 characters').max(200),
  phone_number: phoneNumber,
  latitude,
  longitude,
  address: z.string().trim().max(500).optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
  });

const listSchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const nearbySchema = z.object({
  lat: latitude,
  lng: longitude,
  radius: z.coerce.number().positive().max(500_000).default(env.SEARCH_RADIUS_METERS),
  limit: z.coerce.number().int().min(1).max(50).default(env.MAX_PHARMACIES_PER_BROADCAST),
});

const uuid = z.string().uuid('id must be a UUID');

/** GET /api/pharmacies */
export async function index(req, res) {
  const { active, search, limit, offset } = listSchema.parse(req.query);

  const result = await listPharmacies({
    activeOnly: active === 'true',
    search: search ?? null,
    limit,
    offset,
  });

  res.json({ data: result.pharmacies, meta: { total: result.total, limit, offset } });
}

/**
 * GET /api/pharmacies/nearby?lat=&lng=&radius=&limit=
 * The same PostGIS query the broadcaster uses, exposed for map rendering.
 */
export async function nearby(req, res) {
  const { lat, lng, radius, limit } = nearbySchema.parse(req.query);

  const pharmacies = await findNearbyPharmaciesDetailed(lat, lng, radius, limit);

  res.json({
    data: pharmacies,
    meta: { origin: { latitude: lat, longitude: lng }, radius_meters: radius, limit, count: pharmacies.length },
  });
}

/** GET /api/pharmacies/:id */
export async function show(req, res) {
  const id = uuid.parse(req.params.id);
  res.json({ data: await getPharmacyById(id) });
}

/** POST /api/pharmacies — creates, or updates the row holding this phone number. */
export async function create(req, res) {
  const payload = createSchema.parse(req.body);
  const pharmacy = await upsertPharmacy(payload);
  res.status(201).json({ data: pharmacy });
}

/** PATCH /api/pharmacies/:id */
export async function update(req, res) {
  const id = uuid.parse(req.params.id);
  const patch = updateSchema.parse(req.body);
  res.json({ data: await updatePharmacy(id, patch) });
}

/**
 * DELETE /api/pharmacies/:id
 * Deactivates by default; ?hard=true deletes, and is refused if the pharmacy
 * has fulfilment history.
 */
export async function destroy(req, res) {
  const id = uuid.parse(req.params.id);
  const hard = z.enum(['true', 'false']).optional().parse(req.query.hard) === 'true';

  if (hard) {
    const deleted = await deletePharmacy(id);
    return res.json({ data: deleted, meta: { mode: 'deleted' } });
  }

  const deactivated = await deactivatePharmacy(id);
  return res.json({ data: deactivated, meta: { mode: 'deactivated' } });
}

/** POST /api/pharmacies/bulk — seeds many pharmacies in one call. */
export async function bulkCreate(req, res) {
  const items = z.array(createSchema).min(1).max(200).parse(req.body?.pharmacies ?? req.body);

  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.phone_number)) {
      throw badRequest(`Duplicate phone_number in payload: ${item.phone_number}`);
    }
    seen.add(item.phone_number);
  }

  const created = [];
  for (const item of items) {
    created.push(await upsertPharmacy(item));
  }

  res.status(201).json({ data: created, meta: { count: created.length } });
}
