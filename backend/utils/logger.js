const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Read directly from process.env: utils/logger.js is imported by config/env.js's
// consumers and must not create an import cycle back into it.
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const pretty = process.env.NODE_ENV !== 'production';

const SENSITIVE = /^(authorization|x-api-key|authtoken|auth_token|apikey|api_key|service_role_key|password|token|signature)$/i;

/** Redacts credentials so they never reach stdout or a log aggregator. */
function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE.test(key) ? '[redacted]' : scrub(val, depth + 1);
  }
  return out;
}

function emit(level, event, meta) {
  if (LEVELS[level] < configuredLevel) return;

  const payload = { level, time: new Date().toISOString(), event, ...scrub(meta ?? {}) };
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (pretty) {
    const { level: _l, time, event: _e, ...rest } = payload;
    const detail = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    stream(`${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event}${detail}`);
  } else {
    stream(JSON.stringify(payload));
  }
}

export const logger = {
  debug: (event, meta) => emit('debug', event, meta),
  info: (event, meta) => emit('info', event, meta),
  warn: (event, meta) => emit('warn', event, meta),
  error: (event, meta) => emit('error', event, meta),
};

/** Shapes an Error for structured logging without losing Supabase/Twilio detail. */
export function errorMeta(error) {
  if (!error) return {};
  return {
    message: error.message,
    name: error.name,
    code: error.code,
    status: error.status ?? error.statusCode,
    details: error.details,
    hint: error.hint,
    stack: error.stack?.split('\n').slice(0, 4).join(' | '),
  };
}
