import { db } from '../config/db.js';

export interface AdminAlert {
  id: number;
  type: string;
  order_number: string | null;
  message: string;
  read_at: Date | null;
  created_at: Date;
}

/**
 * Records an admin-panel notification — replaces the old "push a WhatsApp
 * message to config.admin.staffPhone" pattern for payment-proof-received and
 * in-person-payment-requested events. The admin panel polls getAlerts()
 * instead of receiving a WhatsApp push.
 */
export async function createAlert(type: string, orderNumber: string, message: string): Promise<void> {
  await db.query(
    `INSERT INTO admin_alerts (type, order_number, message) VALUES ($1, $2, $3)`,
    [type, orderNumber, message]
  );
}

/**
 * Most recent alerts, newest first — capped at 100 since this is a live
 * notification feed, not a full audit log.
 */
export async function getAlerts(): Promise<AdminAlert[]> {
  const { rows } = await db.query(
    `SELECT * FROM admin_alerts ORDER BY created_at DESC LIMIT 100`
  );
  return rows;
}

export async function markAlertRead(id: number): Promise<void> {
  await db.query(`UPDATE admin_alerts SET read_at = NOW() WHERE id = $1`, [id]);
}
