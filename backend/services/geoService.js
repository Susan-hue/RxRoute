import { env } from '../config/env.js';
import { rpc } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { badRequest } from '../utils/httpError.js';
import { isValidCoordinate } from '../utils/format.js';

/**
 * PostGIS query helpers.
 *
 * Every function here is a thin, typed wrapper over a Postgres function defined
 * in db/schema.sql — the distance maths runs in the database against the GIST
 * index, never in Node.
 */

function assertCoordinate(lat, lon) {
  if (!isValidCoordinate(lat, lon)) {
    throw badRequest(`Invalid coordinates: latitude=${lat}, longitude=${lon}. Expected lat ∈ [-90,90], lon ∈ [-180,180].`);
  }
}

/**
 * The PRD's core lookup: the nearest active pharmacies within a radius.
 * Returns [{ id, name, phone_number, distance_meters }], nearest first.
 */
export async function findNearbyPharmacies(
  lat,
  lon,
  radiusMeters = env.SEARCH_RADIUS_METERS,
  limit = env.MAX_PHARMACIES_PER_BROADCAST,
) {
  assertCoordinate(lat, lon);

  const rows = await rpc('find_nearby_pharmacies', {
    patient_lat: lat,
    patient_lon: lon,
    search_radius_meters: radiusMeters,
    max_results: limit,
  });

  const pharmacies = rows ?? [];
  logger.debug('geo.nearby', { lat, lon, radiusMeters, limit, found: pharmacies.length });
  return pharmacies;
}

/** Same lookup with coordinates and address attached, for map rendering. */
export async function findNearbyPharmaciesDetailed(
  lat,
  lon,
  radiusMeters = env.SEARCH_RADIUS_METERS,
  limit = env.MAX_PHARMACIES_PER_BROADCAST,
) {
  assertCoordinate(lat, lon);

  const rows = await rpc('find_nearby_pharmacies_detailed', {
    patient_lat: lat,
    patient_lon: lon,
    search_radius_meters: radiusMeters,
    max_results: limit,
  });

  return rows ?? [];
}

/**
 * Widens the search in stages until something turns up.
 *
 * A patient in a thinly covered area would otherwise get "no pharmacies found"
 * when one sits 6 km away. The escalation is reported back so the broadcast can
 * tell the patient the pharmacy is further out than usual.
 */
export async function findNearbyPharmaciesWithFallback(
  lat,
  lon,
  { radiusMeters, limit, maxRadiusMeters, detailed = false } = {},
) {
  assertCoordinate(lat, lon);

  const baseRadius = radiusMeters ?? env.SEARCH_RADIUS_METERS;
  const ceiling = maxRadiusMeters ?? baseRadius * 4;
  const steps = [baseRadius, baseRadius * 2, ceiling].filter((r, i, arr) => r <= ceiling && arr.indexOf(r) === i);
  const lookup = detailed ? findNearbyPharmaciesDetailed : findNearbyPharmacies;

  for (const radius of steps) {
    const pharmacies = await lookup(lat, lon, radius, limit ?? env.MAX_PHARMACIES_PER_BROADCAST);
    if (pharmacies.length > 0) {
      return { pharmacies, radiusMeters: radius, widened: radius > baseRadius };
    }
  }

  return { pharmacies: [], radiusMeters: steps.at(-1) ?? baseRadius, widened: steps.length > 1 };
}
