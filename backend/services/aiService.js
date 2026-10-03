import { GoogleGenAI, Type } from '@google/genai';
import { env } from '../config/env.js';
import { logger, errorMeta } from '../utils/logger.js';
import { badGateway } from '../utils/httpError.js';

/**
 * Gemini Flash vision wrapper.
 *
 * Responsibility: given an image of a (possibly) handwritten prescription,
 * decide whether it is a genuine medical document and extract the medications.
 * Never throws on a *clinical* negative — an unreadable photo is a valid
 * `{ valid: false }` result, not an error. It throws only when the API itself
 * is unreachable, so callers can distinguish "bad photo" from "service down".
 */

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const PRESCRIPTION_PROMPT = `You are an expert clinical pharmacist. Analyze this image. Determine if it is a valid medical prescription or hospital document. If VALID, extract all medication names and strengths into a strict JSON object: {"valid": true, "drugs": [{"name": "Augmentin", "dose": "625mg"}]}. If INVALID or unreadable, return: {"valid": false, "reason": "Explanation"}. Output ONLY raw valid JSON.

Additional rules:
- Handwriting is expected. Prefer a careful best reading over refusing.
- Expand common prescription abbreviations in the dose where you are confident (e.g. "1g bd" -> "1g twice daily").
- If a medication name is legible but its strength is not, include the medication with an empty dose rather than dropping it.
- If the image is a photo of a screen, a receipt, a product box, a person, a landscape, or any non-medical object, it is INVALID.
- If the document is medical but contains no prescribed medication at all (e.g. a lab result), return valid: false with a reason that says so.
- Set confidence between 0 and 1 reflecting how legible the document was.`;

// Structured output: constrains the model to this shape so no prose or markdown
// fences can leak in. `valid` is the only required field — `drugs` and `reason`
// are mutually exclusive in practice.
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    valid: { type: Type.BOOLEAN, description: 'True if this is a readable medical prescription.' },
    drugs: {
      type: Type.ARRAY,
      description: 'Medications found. Empty when valid is false.',
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: 'Medication name as written.' },
          dose: { type: Type.STRING, description: 'Strength and/or frequency, e.g. "625mg" or "1g twice daily".' },
        },
        required: ['name'],
      },
    },
    reason: { type: Type.STRING, description: 'Why the image was rejected. Empty when valid is true.' },
    confidence: { type: Type.NUMBER, description: 'Legibility confidence from 0 to 1.' },
  },
  required: ['valid'],
};

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulls JSON out of a response. Structured output should make this a plain
 * JSON.parse, but a model under load can still wrap output in ```json fences,
 * so we strip those and fall back to the outermost brace pair.
 */
function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

/** Coerces whatever the model returned into the shape the pipeline relies on. */
function normaliseAnalysis(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, drugs: [], reason: 'AI vision returned an unreadable response.', confidence: null };
  }

  const valid = raw.valid === true;

  const drugs = Array.isArray(raw.drugs)
    ? raw.drugs
        .map((drug) => {
          if (typeof drug === 'string') return { name: drug.trim(), dose: '' };
          const name = (drug?.name ?? '').toString().trim();
          if (!name) return null;
          return { name, dose: (drug?.dose ?? drug?.strength ?? '').toString().trim() };
        })
        .filter(Boolean)
    : [];

  // A "valid" verdict with nothing extracted cannot be fulfilled by a
  // pharmacy, so it is downgraded to invalid here rather than broadcasting an
  // empty order.
  if (valid && drugs.length === 0) {
    return {
      valid: false,
      drugs: [],
      reason: (raw.reason ?? '').toString().trim() || 'No medications could be read from this prescription.',
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    };
  }

  return {
    valid,
    drugs,
    reason: valid ? null : (raw.reason ?? '').toString().trim() || 'The image is not a readable medical prescription.',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
  };
}

/**
 * Analyses a prescription image.
 *
 * @param {Buffer} imageBuffer   Raw image bytes (downloaded from Twilio).
 * @param {string} mimeType      e.g. "image/jpeg".
 * @returns {Promise<{valid: boolean, drugs: Array<{name: string, dose: string}>, reason: string|null, confidence: number|null, model: string, raw: object|null}>}
 * @throws  When the Gemini API is unreachable after retries.
 */
export async function analysePrescriptionImage(imageBuffer, mimeType = 'image/jpeg') {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw badGateway('Cannot analyse an empty image buffer');
  }

  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { text: PRESCRIPTION_PROMPT },
              { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
            ],
          },
        ],
        config: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      const text = response.text;
      const parsed = parseJsonResponse(text);

      if (!parsed) {
        logger.warn('ai.unparseable_response', { attempt, preview: (text ?? '').slice(0, 300) });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(400 * attempt);
          continue;
        }
        return {
          ...normaliseAnalysis(null),
          model: env.GEMINI_MODEL,
          raw: { unparseable: true, preview: (text ?? '').slice(0, 500) },
        };
      }

      const analysis = normaliseAnalysis(parsed);

      logger.info('ai.analysed', {
        valid: analysis.valid,
        drugCount: analysis.drugs.length,
        confidence: analysis.confidence,
        durationMs: Date.now() - startedAt,
        attempt,
      });

      return { ...analysis, model: env.GEMINI_MODEL, raw: parsed };
    } catch (error) {
      lastError = error;
      const status = error.status ?? error.code;
      const retryable = RETRYABLE_STATUS.has(Number(status)) || /fetch failed|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message ?? '');

      logger.warn('ai.attempt_failed', { attempt, retryable, ...errorMeta(error) });

      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(600 * 2 ** (attempt - 1));
    }
  }

  throw badGateway(`Gemini vision request failed: ${lastError?.message ?? 'unknown error'}`, {
    model: env.GEMINI_MODEL,
    status: lastError?.status ?? lastError?.code,
  });
}

/** Lightweight connectivity probe used by GET /health/deep. */
export async function checkGeminiReachable() {
  try {
    const response = await ai.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: 'Reply with the single word: ok',
      // thinkingBudget 0 keeps the probe cheap; 2.5 Flash would otherwise spend
      // reasoning tokens on it and could exhaust maxOutputTokens before replying.
      config: { temperature: 0, maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } },
    });
    return { ok: true, model: env.GEMINI_MODEL, reply: (response.text ?? '').trim().slice(0, 32) };
  } catch (error) {
    return { ok: false, model: env.GEMINI_MODEL, error: error.message };
  }
}
