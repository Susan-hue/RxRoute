/** Presentation helpers shared by the WhatsApp templates and the REST layer. */

/** "Augmentin 625mg, Ibuprofen 400mg" from the extracted_drugs JSONB array. */
export function formatDrugList(drugs) {
  if (!Array.isArray(drugs) || drugs.length === 0) return 'Unspecified medication';

  return drugs
    .map((drug) => {
      if (typeof drug === 'string') return drug.trim();
      const name = (drug?.name ?? '').toString().trim();
      const dose = (drug?.dose ?? '').toString().trim();
      if (!name) return dose || null;
      return dose ? `${name} ${dose}` : name;
    })
    .filter(Boolean)
    .join(', ') || 'Unspecified medication';
}

/** Bulleted list for the longer "order claimed" confirmation. */
export function formatDrugLines(drugs) {
  if (!Array.isArray(drugs) || drugs.length === 0) return '• Unspecified medication';

  return drugs
    .map((drug) => {
      if (typeof drug === 'string') return `• ${drug.trim()}`;
      const name = (drug?.name ?? '').toString().trim();
      const dose = (drug?.dose ?? '').toString().trim();
      const qty = (drug?.quantity ?? '').toString().trim();
      const parts = [name, dose, qty].filter(Boolean);
      return parts.length ? `• ${parts.join(' — ')}` : null;
    })
    .filter(Boolean)
    .join('\n') || '• Unspecified medication';
}

/** Metres under 1 km, kilometres to one decimal above it. */
export function formatDistance(meters) {
  if (meters === null || meters === undefined || Number.isNaN(Number(meters))) return 'unknown distance';
  const m = Number(meters);
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Turn-by-turn link from the patient's pin to the pharmacy. */
export function googleMapsDirectionsUrl({ fromLat, fromLon, toLat, toLon }) {
  const hasOrigin = Number.isFinite(fromLat) && Number.isFinite(fromLon);
  const params = new URLSearchParams({ api: '1', destination: `${toLat},${toLon}` });
  if (hasOrigin) params.set('origin', `${fromLat},${fromLon}`);
  params.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Drop-pin link for a single coordinate. */
export function googleMapsPinUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/**
 * Parses a claim reply. Accepts the documented "YES-RX0001" plus the shapes
 * people actually type: "yes rx0001", "YES:RX0001", "yesrx0001", or the bare
 * reference on its own.
 */
export function parseClaimCommand(body) {
  if (typeof body !== 'string') return null;

  const text = body.trim().toUpperCase();
  const withYes = text.match(/^YES\s*[-:\s_]?\s*(RX[0-9A-HJKMNP-TV-Z]{2,10})$/);
  if (withYes) return withYes[1];

  const bare = text.match(/^(RX[0-9A-HJKMNP-TV-Z]{2,10})$/);
  if (bare) return bare[1];

  return null;
}

/** Parses "STATUS RX0001" / "status rx0001". */
export function parseStatusCommand(body) {
  if (typeof body !== 'string') return null;
  const match = body.trim().toUpperCase().match(/^STATUS\s*[-:\s_]?\s*(RX[0-9A-HJKMNP-TV-Z]{2,10})$/);
  return match ? match[1] : null;
}

/** True for "HELP", "HI", "START" and friends. */
export function isHelpCommand(body) {
  if (typeof body !== 'string') return false;
  return /^(help|hi|hello|hey|start|menu|\?)$/i.test(body.trim());
}

/**
 * Normalises a phone number to Twilio's WhatsApp channel format.
 * "2348012345678", "+234 801 234 5678" and "whatsapp:+2348012345678" all
 * converge on "whatsapp:+2348012345678".
 *
 * National formats with a trunk prefix ("08031112233") are rejected rather than
 * guessed at: no country code is present, and inferring one would silently
 * create a pharmacy record that Twilio can never deliver to. Callers surface
 * the rejection so the operator supplies full international format.
 */
export function normaliseWhatsappNumber(value) {
  if (typeof value !== 'string') return null;

  let raw = value.trim();
  if (!raw) return null;

  raw = raw.replace(/^whatsapp:/i, '').replace(/[\s()\-.]/g, '');

  // "00234…" is the international access prefix; "+" is the canonical form.
  if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;
  if (!raw.startsWith('+')) raw = `+${raw}`;

  // E.164 country codes never begin with 0, so a leading zero means this is a
  // national number missing its country code.
  if (raw.startsWith('+0')) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(raw)) return null;

  return `whatsapp:${raw}`;
}

/** Strips the channel prefix for display. */
export function displayPhone(value) {
  return typeof value === 'string' ? value.replace(/^whatsapp:/i, '') : value;
}

/** Coerces a querystring/form value to a finite number, or null. */
export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Validates a WGS84 coordinate pair. */
export function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
