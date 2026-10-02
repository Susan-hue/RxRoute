#!/usr/bin/env node
/**
 * Proves the backend is wired to a real database — not mocks.
 *
 *   npm run db:verify
 *
 * Checks, in order: tables exist, PostGIS is enabled, the RPC surface is
 * registered with PostgREST, the seed data is present, and distances come back
 * from a live geospatial query. Exits non-zero on the first hard failure.
 */
import process from 'node:process';
import { supabase, rpc } from '../config/supabase.js';
import { env } from '../config/env.js';

const DEMO_PIN = { lat: 6.5095, lon: 3.3711, label: 'Yaba, Lagos' };

const checks = [];
let failed = 0;

function record(name, ok, detail) {
  checks.push({ check: name, result: ok ? '✓ pass' : '✗ FAIL', detail });
  if (!ok) failed += 1;
}

async function run() {
  console.log(`\nRxRoute database verification → ${env.SUPABASE_URL}\n`);

  // --- Tables --------------------------------------------------------------
  for (const table of [
    'pharmacies',
    'prescription_requests',
    'prescription_broadcasts',
    'patient_sessions',
    'whatsapp_messages',
  ]) {
    const { count, error } = await supabase.from(table).select('*', { head: true, count: 'exact' });
    record(`table ${table}`, !error, error ? error.message : `${count ?? 0} rows`);
  }

  // --- Views ---------------------------------------------------------------
  for (const view of ['pharmacies_view', 'prescription_requests_view']) {
    const { error } = await supabase.from(view).select('*', { head: true, count: 'exact' });
    record(`view ${view}`, !error, error ? error.message : 'readable');
  }

  // --- RPC surface ---------------------------------------------------------
  const rpcProbes = [
    ['find_nearby_pharmacies', { patient_lat: DEMO_PIN.lat, patient_lon: DEMO_PIN.lon, search_radius_meters: 1 }],
    ['find_nearby_pharmacies_detailed', { patient_lat: DEMO_PIN.lat, patient_lon: DEMO_PIN.lon, search_radius_meters: 1 }],
    ['get_rxroute_stats', {}],
    ['get_patient_session', { p_phone_number: 'whatsapp:+10000000000' }],
    ['get_prescription_detail', { p_id_or_code: 'RX-DOES-NOT-EXIST' }],
    ['expire_stale_prescription_requests', { p_older_than_minutes: 100_000 }],
    ['claim_prescription_request', { p_short_code: 'RXZZZZ', p_pharmacy_phone: 'whatsapp:+10000000000' }],
  ];

  for (const [fn, args] of rpcProbes) {
    const { error } = await supabase.rpc(fn, args);
    record(`rpc ${fn}`, !error, error ? error.message : 'callable');
  }

  // --- Live PostGIS query --------------------------------------------------
  try {
    const nearby = await rpc('find_nearby_pharmacies', {
      patient_lat: DEMO_PIN.lat,
      patient_lon: DEMO_PIN.lon,
      search_radius_meters: env.SEARCH_RADIUS_METERS,
      max_results: env.MAX_PHARMACIES_PER_BROADCAST,
    });

    const found = nearby?.length ?? 0;
    record(
      `PostGIS lookup from ${DEMO_PIN.label}`,
      found > 0,
      found > 0
        ? `${found} pharmac${found === 1 ? 'y' : 'ies'} within ${env.SEARCH_RADIUS_METERS} m`
        : 'no pharmacies in range — run `npm run db:seed`',
    );

    if (found > 0) {
      console.table(
        nearby.map((p) => ({
          pharmacy: p.name,
          whatsapp: p.phone_number,
          metres: Math.round(p.distance_meters),
        })),
      );
    }
  } catch (error) {
    record('PostGIS lookup', false, error.message);
  }

  // --- Stats ---------------------------------------------------------------
  try {
    const stats = await rpc('get_rxroute_stats');
    console.log('\nLive counters from the database:');
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    record('get_rxroute_stats', false, error.message);
  }

  console.log('\nResults:');
  console.table(checks);

  if (failed > 0) {
    console.error(`\n✗ ${failed} check(s) failed. Apply db/schema.sql (npm run db:push), then db/seed.sql (npm run db:seed).\n`);
    process.exit(1);
  }

  console.log('\n✓ All checks passed — the backend is talking to a real Supabase/PostGIS database.\n');
}

run().catch((error) => {
  console.error('\nVerification crashed:', error.message);
  process.exit(1);
});
