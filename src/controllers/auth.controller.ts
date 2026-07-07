import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { AuthenticatedRequest } from '../middlewares/auth.js';
import * as adminAuthService from '../services/adminAuth.service.js';

/**
 * Authenticates an admin account and issues a session token.
 */
export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const { token, admin } = await adminAuthService.login(email, password);
  res.json({ token, admin });
});

/**
 * Returns the authenticated admin's own profile.
 */
export const getProfile = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const admin = await adminAuthService.getProfile(req.user.id);
  res.json({ admin });
});

/**
 * Updates the authenticated admin's name and/or email.
 */
export const changeProfile = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { name, email } = req.body;
  const admin = await adminAuthService.changeProfile(req.user.id, { name, email });
  res.json({ admin });
});

/**
 * Changes the authenticated admin's password (requires the current password).
 */
export const changePassword = catchAsync(async (req: AuthenticatedRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  await adminAuthService.changePassword(req.user.id, currentPassword, newPassword);
  res.json({ success: true });
});

/**
 * Sends a 6-digit password-reset code to the admin's WhatsApp number. Always
 * responds the same way regardless of whether the email matched an account,
 * so this endpoint can't be used to enumerate admin emails.
 */
export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body;
  await adminAuthService.forgotPassword(email);
  res.json({ message: 'If that email is registered, a reset code has been sent via WhatsApp.' });
});

/**
 * Completes a password reset using the code sent by forgotPassword.
 */
export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { email, code, newPassword } = req.body;
  await adminAuthService.resetPassword(email, code, newPassword);
  res.json({ success: true });
});
