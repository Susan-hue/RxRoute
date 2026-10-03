import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Centralised, validated configuration.
 *
 * The process refuses to boot without the credentials it needs to reach the
 * real Supabase / Twilio / Gemini services — there is no in-memory fallback to
 * silently degrade into, so a missing key must fail loudly at startup rather
 * than halfway through a patient's prescription.
 */

const booleanish = (fallback) =>
  z
    .union([z.boolean(), z.string()])
    .default(fallback)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Supabase -----------------------------------------------------------
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a full https URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks truncated'),

  // --- Twilio -------------------------------------------------------------
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'TWILIO_ACCOUNT_SID must look like ACxxxx…'),
  TWILIO_AUTH_TOKEN: z.string().min(16, 'TWILIO_AUTH_TOKEN looks truncated'),
  TWILIO_WHATSAPP_NUMBER: z
    .string()
    .regex(/^whatsapp:\+\d{7,15}$/, 'TWILIO_WHATSAPP_NUMBER must look like whatsapp:+14155238886'),

  // --- Gemini -------------------------------------------------------------
  GEMINI_API_KEY: z.string().min(10, 'GEMINI_API_KEY looks truncated'),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  // --- Routing behaviour --------------------------------------------------
  SEARCH_RADIUS_METERS: z.coerce.number().positive().default(5000),
  MAX_PHARMACIES_PER_BROADCAST: z.coerce.number().int().positive().max(50).default(5),
  REQUEST_EXPIRY_MINUTES: z.coerce.number().int().positive().default(30),
  CLAIM_REQUIRES_BROADCAST: booleanish('true'),
  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  // --- Webhook / API hardening -------------------------------------------
  // Twilio signature validation needs the exact public URL Twilio posted to.
  PUBLIC_BASE_URL: z.string().url().optional(),
  VALIDATE_TWILIO_SIGNATURE: booleanish('false'),
  // Ack the webhook immediately, then run AI + fan-out in the background.
  // Twilio times a webhook out at 15s; Gemini plus five sends can exceed that.
  WEBHOOK_ASYNC: booleanish('true'),
  // When set, /api/* requires `x-api-key` (or Bearer) matching this value.
  API_KEY: z.string().min(8).optional(),

  // --- Public web app (/api/public/*) -------------------------------------
  // Comma-separated origins allowed to call the public API from a browser,
  // e.g. https://rxroute.vercel.app. Not needed in development: Vite proxies.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)),
  // Each upload costs a Gemini call and up to five outbound messages.
  PUBLIC_UPLOADS_PER_HOUR: z.coerce.number().int().positive().default(20),

  // --- Tooling only (scripts/applySql.js, scripts/verifyDb.js) ------------
  DATABASE_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  console.error(`\n[RxRoute] Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === 'production';
