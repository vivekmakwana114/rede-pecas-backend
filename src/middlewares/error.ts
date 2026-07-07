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
  logger.error(`[Error Handler] ${statusCode} - ${message} - Stack: ${err.stack}`);

  res.status(statusCode).json({
    success: false,
    message,
    code: statusCode,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
}
