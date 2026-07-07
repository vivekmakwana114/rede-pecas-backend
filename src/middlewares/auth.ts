import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return next(new ApiError(401, 'Unauthorized. Missing token.'));
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return next(new ApiError(401, 'Unauthorized. Invalid token format.'));
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as any;
    // Refresh tokens are only valid at POST /admin/refresh — never as a general
    // bearer token, so a leaked one can't be used to access protected routes directly.
    if (decoded.type === 'refresh') {
      return next(new ApiError(401, 'Unauthorized. Invalid token type.'));
    }
    req.user = decoded;
    next();
  } catch {
    return next(new ApiError(401, 'Unauthorized. Invalid or expired token.'));
  }
}
