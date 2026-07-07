import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { AuthenticatedRequest } from '../middlewares/auth.js';
import * as adminAuthService from '../services/adminAuth.service.js';

/**
 * Authenticates an admin account and issues an access + refresh token pair.
 */
export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const { accessToken, refreshToken, admin } = await adminAuthService.login(email, password);

  res.status(200).json({
    success: true,
    message: 'Login successful.',
    code: 200,
    data: { admin },
    accessToken,
    refreshToken,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Exchanges a refresh token for a new access token.
 */
export const refresh = catchAsync(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  const { accessToken, admin } = await adminAuthService.refreshAccessToken(refreshToken);

  res.status(200).json({
    success: true,
    message: 'Access token refreshed.',
    code: 200,
    data: { admin },
    accessToken,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Returns the authenticated admin's own profile.
 */
export const getProfile = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const admin = await adminAuthService.getProfile(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Profile retrieved.',
    code: 200,
    data: { admin },
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Updates the authenticated admin's name and/or email.
 */
export const changeProfile = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { name, email } = req.body;
  const admin = await adminAuthService.changeProfile(req.user.id, { name, email });

  res.status(200).json({
    success: true,
    message: 'Profile updated.',
    code: 200,
    data: { admin },
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Changes the authenticated admin's password (requires the current password).
 */
export const changePassword = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  await adminAuthService.changePassword(req.user.id, currentPassword, newPassword);

  res.status(200).json({
    success: true,
    message: 'Password changed successfully.',
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Sends a 6-digit password-reset code to the admin's WhatsApp number. Always
 * responds the same way regardless of whether the email matched an account,
 * so this endpoint can't be used to enumerate admin emails.
 */
export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body;
  await adminAuthService.forgotPassword(email);

  res.status(200).json({
    success: true,
    message: 'If that email is registered, a reset code has been sent via WhatsApp.',
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Completes a password reset using the code sent by forgotPassword.
 */
export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { email, code, newPassword } = req.body;
  await adminAuthService.resetPassword(email, code, newPassword);

  res.status(200).json({
    success: true,
    message: 'Password reset successfully.',
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});
