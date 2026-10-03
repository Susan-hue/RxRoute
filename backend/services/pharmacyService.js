import { supabase, rpc, assertNoDbError } from '../config/supabase.js';
import { notFound, conflict } from '../utils/httpError.js';

/** Pharmacy CRUD. Reads go through pharmacies_view, which projects lat/lng. */

export async function listPharmacies({ activeOnly = false, search = null, limit = 100, offset = 0 } = {}) {
  let query = supabase
    .from('pharmacies_view')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (activeOnly) query = query.eq('is_active', true);
  if (search) query = query.or(`name.ilike.%${search}%,address.ilike.%${search}%`);

  const { data, error, count } = await query;
  assertNoDbError(error, 'listPharmacies');

  return { pharmacies: data ?? [], total: count ?? 0, limit, offset };
}

export async function getPharmacyById(id) {
  const { data, error } = await supabase.from('pharmacies_view').select('*').eq('id', id).maybeSingle();
  assertNoDbError(error, 'getPharmacyById');

  if (!data) throw notFound(`No pharmacy with id ${id}`);
  return data;
}

export async function getPharmacyByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from('pharmacies_view')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  assertNoDbError(error, 'getPharmacyByPhone');
  return data ?? null;
}

/** Create, or update the existing row when phone_number already exists. */
export async function upsertPharmacy({ name, phone_number, latitude, longitude, address = null, is_active = true }) {
  return rpc('upsert_pharmacy', {
    p_name: name,
    p_phone_number: phone_number,
    p_lat: latitude,
    p_lon: longitude,
    p_address: address,
    p_is_active: is_active,
  });
}

export async function updatePharmacy(id, patch) {
  const result = await rpc('update_pharmacy', {
    p_id: id,
    p_name: patch.name ?? null,
    p_address: patch.address ?? null,
    p_lat: patch.latitude ?? null,
    p_lon: patch.longitude ?? null,
    p_is_active: patch.is_active ?? null,
  });

  if (!result?.found) throw notFound(`No pharmacy with id ${id}`);

  const { found, ...pharmacy } = result;
  return pharmacy;
}

/**
 * Deactivates a pharmacy. Hard deletion is deliberately not offered: a
 * pharmacy is referenced by prescription_requests.claimed_by_pharmacy_id, and
 * destroying that reference would rewrite the fulfilment history.
 */
export async function deactivatePharmacy(id) {
  const { data, error } = await supabase
    .from('pharmacies')
    .update({ is_active: false })
    .eq('id', id)
    .select('id, name, is_active')
    .maybeSingle();

  assertNoDbError(error, 'deactivatePharmacy');
  if (!data) throw notFound(`No pharmacy with id ${id}`);

  return data;
}

/**
 * Permanently removes a pharmacy that has never claimed an order.
 * Refuses when fulfilment history would be lost — deactivate instead.
 */
export async function deletePharmacy(id) {
  const { count, error: countError } = await supabase
    .from('prescription_requests')
    .select('id', { head: true, count: 'exact' })
    .eq('claimed_by_pharmacy_id', id);

  assertNoDbError(countError, 'deletePharmacy.history');

  if ((count ?? 0) > 0) {
    throw conflict(
      `Pharmacy ${id} has claimed ${count} prescription(s) and cannot be deleted. Deactivate it instead (PATCH with is_active: false).`,
    );
  }

  const { data, error } = await supabase.from('pharmacies').delete().eq('id', id).select('id, name').maybeSingle();
  assertNoDbError(error, 'deletePharmacy');

  if (!data) throw notFound(`No pharmacy with id ${id}`);
  return data;
}
