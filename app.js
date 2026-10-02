import express from 'express';
import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  // Behind ngrok / a platform load balancer, trust the forwarding headers so
  // req.ip and req.protocol reflect the original client.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Twilio posts application/x-www-form-urlencoded; everything else is JSON.
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Request logging with duration, skipping health-check noise.
  app.use((req, res, next) => {
    if (req.path.startsWith('/health')) return next();

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('http', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      });
    });
    return next();
  });

  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
