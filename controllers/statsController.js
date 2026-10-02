import { rpc, supabase, assertNoDbError } from '../config/supabase.js';
import { env } from '../config/env.js';
import { verifyTwilioCredentials } from '../config/twilio.js';
import { checkGeminiReachable } from '../services/aiService.js';

/** GET /api/stats — dashboard counters, aggregated in Postgres. */
export async function stats(req, res) {
  res.json({ data: await rpc('get_rxroute_stats') });
}

/**
 * GET /api/activity — the most recent prescriptions with their winning
 * pharmacy, for a live feed.
 */
export async function activity(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '20', 10) || 20, 1), 100);

  const { data, error } = await supabase
    .from('prescription_requests_view')
    .select('short_code, patient_phone, extracted_drugs, status, claimed_by_name, claimed_at, broadcast_count, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  assertNoDbError(error, 'activity');

  res.json({ data: data ?? [], meta: { limit, count: data?.length ?? 0 } });
}

/** GET /health — liveness. No external calls, safe for an uptime check. */
export function health(req, res) {
  res.json({
    status: 'ok',
    service: 'rxroute',
    env: env.NODE_ENV,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /health/deep — readiness. Round-trips Supabase, PostGIS, Twilio and
 * Gemini, and returns 503 if any dependency is down.
 */
export async function deepHealth(req, res) {
  const checks = {};

  // Supabase + PostGIS
  try {
    const { count, error } = await supabase.from('pharmacies').select('id', { head: true, count: 'exact' });
    if (error) throw error;

    const geo = await rpc('find_nearby_pharmacies', {
      patient_lat: 6.5095,
      patient_lon: 3.3711,
      search_radius_meters: env.SEARCH_RADIUS_METERS,
    });

    checks.supabase = { ok: true, pharmacies: count ?? 0 };
    checks.postgis = { ok: true, nearby_demo_pin: geo?.length ?? 0 };
  } catch (error) {
    checks.supabase = { ok: false, error: error.message };
    checks.postgis = { ok: false, error: 'skipped — database unreachable' };
  }

  const [twilioOk, gemini] = await Promise.all([verifyTwilioCredentials(), checkGeminiReachable()]);

  checks.twilio = { ok: twilioOk, from: env.TWILIO_WHATSAPP_NUMBER };
  checks.gemini = gemini;

  const allOk = Object.values(checks).every((c) => c.ok);

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
}
