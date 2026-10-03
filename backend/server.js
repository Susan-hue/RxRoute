import { env } from './config/env.js';
import { createApp } from './app.js';
import { verifyDatabaseConnection } from './config/supabase.js';
import { verifyTwilioCredentials } from './config/twilio.js';
import { expireStalePrescriptions } from './services/prescriptionService.js';
import { logger, errorMeta } from './utils/logger.js';

const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  // Fail fast on a database that is unreachable or missing db/schema.sql — far
  // better than discovering it when the first patient sends a prescription.
  await verifyDatabaseConnection();

  // Non-fatal: Twilio being briefly unreachable should not stop the REST API.
  await verifyTwilioCredentials();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info('server.listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      webhook: `${env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`}/webhook/whatsapp`,
      signatureValidation: env.VALIDATE_TWILIO_SIGNATURE,
      asyncWebhook: env.WEBHOOK_ASYNC,
      searchRadiusMeters: env.SEARCH_RADIUS_METERS,
    });
  });

  // Periodically age out requests nobody claimed, so the pending queue reflects
  // reality. unref() keeps the timer from holding the process open on shutdown.
  const sweep = setInterval(() => {
    expireStalePrescriptions().catch((error) => logger.warn('expiry_sweep.failed', errorMeta(error)));
  }, EXPIRY_SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = (signal) => {
    logger.info('server.shutdown', { signal });
    clearInterval(sweep);

    server.close(() => process.exit(0));
    // Don't let a hung in-flight connection block the exit indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', errorMeta(reason instanceof Error ? reason : new Error(String(reason))));
  });

  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', errorMeta(error));
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('server.startup_failed', errorMeta(error));
  process.exit(1);
});
