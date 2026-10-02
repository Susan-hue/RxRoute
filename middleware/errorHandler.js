import { ZodError } from 'zod';
import { logger, errorMeta } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

/** 404 for unmatched routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'not_found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
}

/** Terminal error middleware. Must keep all four arguments for Express. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'Request payload failed validation',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const status = error.status ?? error.statusCode ?? 500;

  if (status >= 500) {
    logger.error('request.failed', {
      method: req.method,
      path: req.originalUrl,
      ...errorMeta(error),
    });
  } else {
    logger.warn('request.rejected', {
      method: req.method,
      path: req.originalUrl,
      status,
      message: error.message,
    });
  }

  const body = {
    error: error.code ?? (status >= 500 ? 'internal_error' : 'request_error'),
    message: status >= 500 && isProduction ? 'An unexpected error occurred' : error.message,
  };

  if (error.details !== undefined) body.details = error.details;
  if (!isProduction && status >= 500) body.stack = error.stack?.split('\n').slice(0, 6);

  res.status(status).json(body);
}
