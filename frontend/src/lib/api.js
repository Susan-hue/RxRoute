const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

const OFFLINE_MESSAGE = "We couldn't reach RxRoute. Check your internet connection and try again.";

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function errorFromResponse(response) {
  try {
    const body = await response.json();
    const message = body.issues?.[0]?.message ?? body.message;
    return new ApiError(message ?? `Request failed (${response.status}).`, response.status);
  } catch {
    return new ApiError(`Request failed (${response.status}).`, response.status);
  }
}

async function request(path, options) {
  try {
    return await fetch(`${BASE_URL}${path}`, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(OFFLINE_MESSAGE);
  }
}

/**
 * Sends the photo, phone number and location, then reads the backend's
 * newline-delimited progress events until the final result arrives.
 *
 * @param {object} args
 * @param {Blob} args.photo
 * @param {string} args.phone
 * @param {number} args.latitude
 * @param {number} args.longitude
 * @param {(stage: 'analyzing'|'locating'|'broadcasting') => void} [args.onStage]
 */
export async function submitPrescription({ photo, phone, latitude, longitude, onStage }) {
  const form = new FormData();
  form.set('photo', photo, photo.name ?? 'prescription.jpg');
  form.set('phone', phone);
  form.set('latitude', String(latitude));
  form.set('longitude', String(longitude));

  const response = await request('/api/public/prescriptions', { method: 'POST', body: form });
  if (!response.ok) throw await errorFromResponse(response);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new ApiError('The connection dropped before your request finished. Please try again.');
    }

    if (chunk.value) buffered += chunk.value;

    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;

      const event = JSON.parse(line);
      if (event.type === 'stage') onStage?.(event.stage);
      if (event.type === 'result') return event.data;
      if (event.type === 'error') throw new ApiError(event.message, event.status);
    }

    if (chunk.done) break;
  }

  throw new ApiError('The connection closed before your request finished. Please try again.');
}

/** Current state of a request: pending, claimed (with the pharmacy), expired or failed. */
export async function getPrescriptionStatus(id) {
  const response = await request(`/api/public/prescriptions/${encodeURIComponent(id)}`);
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()).data;
}
