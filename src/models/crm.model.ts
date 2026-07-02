import { db } from '../config/db.js';

export interface Customer {
  phone: string;
  name: string | null;
  nif: string | null;
  address: string | null;
  email: string | null;
  registration_status: string;
  first_contact_at: Date;
  last_contact_at: Date;
  registered_at: Date | null;
  contact_count: number;
  active: boolean;
}

export interface CRMStats {
  total_customers: number;
  registered: number;
  active_30_days: number;
  new_this_week: number;
  with_nif: number;
  with_address: number;
}

/**
 * Retrieves a customer by phone number and updates their last contact date & total contact count.
 */
export async function getAndUpdateCustomer(phone: string): Promise<Customer | null> {
  const { rows } = await db.query(
    `SELECT * FROM customers WHERE phone = $1`,
    [phone]
  );
  if (!rows.length) return null;

  // Update last contact timestamp and increment contact count
  await db.query(
    `UPDATE customers
     SET last_contact_at = NOW(),
         contact_count = contact_count + 1
     WHERE phone = $1`,
    [phone]
  );

  return rows[0];
}

/**
 * Retrieves a customer by phone number without updating metadata.
 */
export async function getCustomerByPhone(phone: string): Promise<Customer | null> {
  const { rows } = await db.query(
    `SELECT * FROM customers WHERE phone = $1`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Creates a pre-registration entry for a new customer.
 */
export async function createCustomerPreRegistration(phone: string, registrationStatus: string): Promise<void> {
  await db.query(
    `INSERT INTO customers (phone, registration_status, first_contact_at, last_contact_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (phone) DO NOTHING`,
    [phone, registrationStatus]
  );
}

/**
 * Updates columns for a customer record.
 */
export async function updateCustomer(phone: string, fields: Partial<Customer>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map((key) => (fields as any)[key]);

  await db.query(
    `UPDATE customers SET ${setClauses} WHERE phone = $1`,
    [phone, ...values]
  );
}

/**
 * Retrieves customers based on segment rules.
 */
export async function getCustomersBySegment(segment: string, limit: number): Promise<{ phone: string; name: string | null }[]> {
  const queries: { [key: string]: { sql: string; hasParams: boolean } } = {
    all: {
      sql: `SELECT phone, name FROM customers WHERE registration_status = 'complete' AND active = true ORDER BY last_contact_at DESC LIMIT $1`,
      hasParams: true
    },
    inactive_30_days: {
      sql: `SELECT phone, name FROM customers WHERE registration_status = 'complete' AND active = true AND last_contact_at < NOW() - INTERVAL '30 days' LIMIT $1`,
      hasParams: true
    },
    diesel: {
      sql: `SELECT DISTINCT c.phone, c.name FROM customers c JOIN vehicle_sessions vs ON vs.phone = c.phone WHERE c.registration_status = 'complete' AND vs.fuel_type ILIKE '%diesel%' LIMIT $1`,
      hasParams: true
    },
    luanda: {
      sql: `SELECT phone, name FROM customers WHERE registration_status = 'complete' AND active = true AND address ILIKE '%luanda%' LIMIT $1`,
      hasParams: true
    },
    frequent_buyers: {
      sql: `SELECT c.phone, c.name, COUNT(o.id) AS total_orders FROM customers c JOIN orders o ON o.customer_phone = c.phone WHERE c.registration_status = 'complete' GROUP BY c.phone, c.name HAVING COUNT(o.id) >= 3 ORDER BY total_orders DESC LIMIT $1`,
      hasParams: true
    },
    no_orders: {
      sql: `SELECT c.phone, c.name FROM customers c WHERE c.registration_status = 'complete' AND c.active = true AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_phone = c.phone) LIMIT $1`,
      hasParams: true
    },
    toyota: {
      sql: `SELECT DISTINCT c.phone, c.name FROM customers c JOIN vehicle_sessions vs ON vs.phone = c.phone WHERE c.registration_status = 'complete' AND vs.make ILIKE '%toyota%' LIMIT $1`,
      hasParams: true
    },
    new_7_days: {
      sql: `SELECT phone, name FROM customers WHERE registration_status = 'complete' AND registered_at > NOW() - INTERVAL '7 days' LIMIT $1`,
      hasParams: true
    }
  };

  const queryObj = queries[segment] || queries.all;
  const { rows } = await db.query(queryObj.sql, [limit]);
  return rows;
}

/**
 * Registers an outbound campaign message send record.
 */
export async function logCampaignSend(phone: string, segment: string): Promise<void> {
  await db.query(
    `INSERT INTO campaign_sends (phone, segment, sent_at)
     VALUES ($1, $2, NOW())`,
    [phone, segment]
  );
}

/**
 * Aggregates analytical statistics for CRM dashboard.
 */
export async function getCRMStats(): Promise<CRMStats> {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                                     AS total_customers,
      COUNT(*) FILTER (WHERE registration_status = 'complete')::int     AS registered,
      COUNT(*) FILTER (
        WHERE last_contact_at > NOW() - INTERVAL '30 days'
      )::int                                                            AS active_30_days,
      COUNT(*) FILTER (
        WHERE registered_at > NOW() - INTERVAL '7 days'
      )::int                                                            AS new_this_week,
      COUNT(*) FILTER (WHERE nif IS NOT NULL)::int                      AS with_nif,
      COUNT(*) FILTER (WHERE address IS NOT NULL)::int                  AS with_address
    FROM customers
  `);
  return rows[0];
}
