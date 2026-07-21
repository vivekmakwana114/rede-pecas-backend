import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import { catchAsync } from '../utils/catchAsync.js';
import { isTokenRevoked } from '../services/session.service.js';

export interface AuthenticatedRequest extends Request {
  user?: any;
  // The raw bearer token, once verified — POST /admin/logout (auth.controller.ts)
  // needs the exact token string to blacklist it, not just its decoded payload.
  token?: string;
}

async function verifyToken(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return next(new ApiError(401, 'Unauthorized. Missing token.'));
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return next(new ApiError(401, 'Unauthorized. Invalid token format.'));
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, config.jwt.secret) as any;
  } catch {
    return next(new ApiError(401, 'Unauthorized. Invalid or expired token.'));
  }

  // Refresh tokens are only valid at POST /admin/refresh — never as a general
  // bearer token, so a leaked one can't be used to access protected routes directly.
  if (decoded.type === 'refresh') {
    return next(new ApiError(401, 'Unauthorized. Invalid token type.'));
  }

  // This JWT setup is otherwise fully stateless — without this check, a token
  // stayed valid right up to its own expiry even after the admin explicitly
  // logged out (see session.service.ts's revokeToken, written by POST /admin/logout).
  if (await isTokenRevoked(token)) {
    return next(new ApiError(401, 'Unauthorized. Token has been revoked.'));
  }

  req.user = decoded;
  req.token = token;
  next();
}

// Wrapped in catchAsync (not just an async function) because this middleware runs
// on Express 4, which doesn't forward a rejected promise from a middleware to the
// error handler on its own — without this, a Redis error thrown inside
// isTokenRevoked would crash the request instead of reaching errorHandler.
export const authMiddleware = catchAsync(verifyToken);
