import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Supabase client, initialised with the service role key.
 *
 * The service role bypasses RLS, which is what a trusted backend wants — and
 * why this key must never be shipped to a browser or mobile client. Session
 * persistence and token refresh are disabled: there is no user session here,
 * just a long-lived server process.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: 'public' },
  global: {
    headers: { 'x-application-name': 'rxroute-backend' },
  },
});

/**
 * Normalises a Supabase/PostgREST error into a thrown Error with context, so
 * callers get a stack trace pointing at the query rather than a silent null.
 */
export function assertNoDbError(error, context) {
  if (!error) return;

  const err = new Error(`Supabase error during ${context}: ${error.message}`);
  err.code = error.code;
  err.details = error.details;
  err.hint = error.hint;
  err.context = context;
  throw err;
}

/** Calls a Postgres function and unwraps the result, throwing on failure. */
export async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  assertNoDbError(error, `rpc ${fn}`);
  return data;
}

/**
 * Verifies the database is reachable and that db/schema.sql has been applied.
 * Called at boot so a misconfigured database surfaces immediately instead of
 * on the first patient's message.
 */
export async function verifyDatabaseConnection() {
  const { error: tableError } = await supabase.from('pharmacies').select('id', { head: true, count: 'exact' });
  if (tableError) {
    throw new Error(
      `Cannot read the "pharmacies" table (${tableError.message}). ` +
        'Has db/schema.sql been applied to this Supabase project?',
    );
  }

  // A trivial PostGIS round-trip: proves the extension is live and the RPC is
  // registered with PostgREST.
  const { error: rpcError } = await supabase.rpc('find_nearby_pharmacies', {
    patient_lat: 6.5095,
    patient_lon: 3.3711,
    search_radius_meters: 1,
  });
  if (rpcError) {
    throw new Error(
      `PostGIS RPC find_nearby_pharmacies is unavailable (${rpcError.message}). ` +
        'Apply db/schema.sql, then run NOTIFY pgrst, \'reload schema\';',
    );
  }

  logger.info('supabase.connected', { url: env.SUPABASE_URL });
}
