export function formatDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function directionsUrl(latitude, longitude) {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;
}

/**
 * Mirrors the backend rule: the form shows a fixed +234 prefix, so 0803…,
 * 803… and 234803… are all the same Nigerian number.
 */
export function isValidNigerianPhone(value) {
  let digits = value.replace(/[\s()\-.]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[1-9]\d{9}$/.test(digits);
}
