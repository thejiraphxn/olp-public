import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation', issues: err.issues });
  }
  const status = err?.status ?? 500;
  if (status >= 500) {
    logger.error({ err, url: req.url, method: req.method }, 'request failed');
  }
  res.status(status).json({ error: err?.message ?? 'internal_error' });
};
