import { Request, Response, NextFunction } from 'express';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

export function errorConverter(err: any, req: Request, res: Response, next: NextFunction) {
  let error = err;
  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';
    error = new ApiError(statusCode, message, false, err.stack);
  }
  next(error);
}

export function errorHandler(err: ApiError, req: Request, res: Response, _next: NextFunction) {
  let { statusCode, message } = err;
  if (config.env === 'production' && !err.isOperational) {
    statusCode = 500;
    message = 'Internal Server Error';
  }

  // Full error (including stack) is always logged server-side — never sent to the
  // client, in development or otherwise. Matches the success envelope's shape
  // (src/utils/apiResponse.ts) so callers only ever need to branch on `success`.
  // Severity follows isOperational + statusCode, not a flat logger.error for
  // everything: an expired/invalid JWT, a bad login, a validation failure — all
  // expected client-side conditions, thrown deliberately as `new ApiError(...)`
  // (isOperational defaults true) — logged at warn. A genuine unexpected crash
  // (errorConverter marks any non-ApiError isOperational: false) stays at error.
  // Without this split, something as routine as a stale admin token after logout
  // polling a protected route floods the logs at error severity indefinitely,
  // burying whatever real error should actually be paged on.
  const logLine = `[Error Handler] ${statusCode} - ${message} - Stack: ${err.stack}`;
  if (err.isOperational && statusCode < 500) {
    logger.warn(logLine);
  } else {
    logger.error(logLine);
  }

  res.status(statusCode).json({
    success: false,
    message,
    code: statusCode,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
}
