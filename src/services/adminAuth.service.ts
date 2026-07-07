import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import {
  AdminUser,
  getAdminByEmail,
  getAdminById,
  updateAdminProfile,
  updateAdminPassword,
  setResetCode,
  clearResetCode,
} from '../models/adminUser.model.js';
import { sendWhatsAppMessage } from './whatsapp.service.js';
import { t } from '../i18n/messages.js';

const RESET_CODE_TTL_MINUTES = 10;

export interface AdminProfile {
  id: number;
  name: string;
  email: string;
  phone: string;
}

function toProfile(admin: AdminUser): AdminProfile {
  return { id: admin.id, name: admin.name, email: admin.email, phone: admin.phone };
}

function signAccessToken(admin: AdminUser): string {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: 'admin' },
    config.jwt.secret,
    { expiresIn: `${config.jwt.accessExpirationMinutes}m` }
  );
}

// `type: 'refresh'` marks this as only usable at POST /admin/refresh — authMiddleware
// rejects it on every other protected route so a leaked refresh token can't be used
// directly as a bearer token.
function signRefreshToken(admin: AdminUser): string {
  return jwt.sign(
    { id: admin.id, email: admin.email, role: 'admin', type: 'refresh' },
    config.jwt.secret,
    { expiresIn: `${config.jwt.refreshExpirationDays}d` }
  );
}

export async function login(
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string; admin: AdminProfile }> {
  const admin = await getAdminByEmail(email.toLowerCase().trim());
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    throw new ApiError(401, 'Incorrect email or password.');
  }

  return {
    accessToken: signAccessToken(admin),
    refreshToken: signRefreshToken(admin),
    admin: toProfile(admin),
  };
}

/**
 * Exchanges a refresh token for a new access token. Stateless (no DB-tracked
 * session) — the refresh token stays valid until its own expiry regardless of
 * password changes; it can't be individually revoked.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; admin: AdminProfile }> {
  let decoded: any;
  try {
    decoded = jwt.verify(refreshToken, config.jwt.secret);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }

  if (decoded.type !== 'refresh') {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }

  const admin = await getAdminById(decoded.id);
  if (!admin) throw new ApiError(401, 'Invalid or expired refresh token.');

  return { accessToken: signAccessToken(admin), admin: toProfile(admin) };
}

export async function getProfile(adminId: number): Promise<AdminProfile> {
  const admin = await getAdminById(adminId);
  if (!admin) throw new ApiError(404, 'Admin account not found.');
  return toProfile(admin);
}

export async function changeProfile(
  adminId: number,
  fields: { name?: string; email?: string }
): Promise<AdminProfile> {
  const admin = await getAdminById(adminId);
  if (!admin) throw new ApiError(404, 'Admin account not found.');

  const updates: { name?: string; email?: string } = {};
  if (fields.name) updates.name = fields.name.trim();
  if (fields.email) {
    const email = fields.email.toLowerCase().trim();
    const existing = await getAdminByEmail(email);
    if (existing && existing.id !== adminId) {
      throw new ApiError(409, 'That email is already in use by another admin account.');
    }
    updates.email = email;
  }

  await updateAdminProfile(adminId, updates);
  return getProfile(adminId);
}

export async function changePassword(
  adminId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const admin = await getAdminById(adminId);
  if (!admin) throw new ApiError(404, 'Admin account not found.');

  if (!(await bcrypt.compare(currentPassword, admin.password_hash))) {
    throw new ApiError(401, 'Current password is incorrect.');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await updateAdminPassword(adminId, passwordHash);
}

/**
 * Sends a 6-digit reset code to the admin's WhatsApp number (no email/SMTP service
 * exists in this project). Always resolves without revealing whether the email
 * matched an account, so this endpoint can't be used to enumerate admin emails.
 */
export async function forgotPassword(email: string): Promise<void> {
  const admin = await getAdminByEmail(email.toLowerCase().trim());
  if (!admin) return;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

  await setResetCode(admin.id, codeHash, expiresAt);

  // Admin phone numbers are entered by hand (unlike customer numbers, which arrive
  // pre-formatted as plain digits straight from the WhatsApp webhook) and the Cloud
  // API's `to` field rejects punctuation — strip everything but digits.
  const phone = admin.phone.replace(/\D/g, '');

  try {
    await sendWhatsAppMessage(phone, t.adminAuth.resetCode(code));
  } catch (error: any) {
    // Must not throw — a delivery failure (bad number, WhatsApp API hiccup) would
    // otherwise surface differently than the "unknown email" case above and leak
    // which emails have accounts. Logged so it's still visible to staff.
    logger.error(`Failed to send admin password-reset code to ${phone}`, error);
  }
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const admin = await getAdminByEmail(email.toLowerCase().trim());
  if (!admin || !admin.reset_code_hash || !admin.reset_code_expires_at) {
    throw new ApiError(400, 'Invalid or expired reset code.');
  }

  if (new Date(admin.reset_code_expires_at).getTime() < Date.now()) {
    await clearResetCode(admin.id);
    throw new ApiError(400, 'Invalid or expired reset code.');
  }

  if (!(await bcrypt.compare(code, admin.reset_code_hash))) {
    throw new ApiError(400, 'Invalid or expired reset code.');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await updateAdminPassword(admin.id, passwordHash);
}
