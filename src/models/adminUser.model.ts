import { db } from '../config/db.js';

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  phone: string;
  password_hash: string;
  reset_code_hash: string | null;
  reset_code_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getAdminByEmail(email: string): Promise<AdminUser | null> {
  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  return rows.length ? rows[0] : null;
}

/**
 * Looks up an admin by phone, ignoring formatting (admin phone numbers are
 * entered by hand and may include spaces/parens/dashes — compares digits only
 * on both sides so the caller doesn't need to normalize before querying).
 */
export async function getAdminByPhone(phone: string): Promise<AdminUser | null> {
  const digitsOnly = phone.replace(/\D/g, '');
  const { rows } = await db.query(
    "SELECT * FROM admin_users WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1",
    [digitsOnly]
  );
  return rows.length ? rows[0] : null;
}

export async function getAdminById(id: number): Promise<AdminUser | null> {
  const { rows } = await db.query('SELECT * FROM admin_users WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

export async function updateAdminProfile(id: number, fields: Partial<Pick<AdminUser, 'name' | 'email'>>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(
    `UPDATE admin_users SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  );
}

/**
 * Updates the password and clears any pending reset code — a successful
 * password change (via change-password or reset-password) invalidates
 * whatever reset code might still be outstanding.
 */
export async function updateAdminPassword(id: number, passwordHash: string): Promise<void> {
  await db.query(
    `UPDATE admin_users
     SET password_hash = $2, reset_code_hash = NULL, reset_code_expires_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, passwordHash]
  );
}

export async function setResetCode(id: number, codeHash: string, expiresAt: Date): Promise<void> {
  await db.query(
    `UPDATE admin_users SET reset_code_hash = $2, reset_code_expires_at = $3 WHERE id = $1`,
    [id, codeHash, expiresAt]
  );
}

export async function clearResetCode(id: number): Promise<void> {
  await db.query(
    `UPDATE admin_users SET reset_code_hash = NULL, reset_code_expires_at = NULL WHERE id = $1`,
    [id]
  );
}
