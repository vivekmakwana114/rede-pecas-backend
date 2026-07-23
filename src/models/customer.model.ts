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

export interface CustomerListParams {
  page: number;
  limit: number;
  q?: string;
}

export interface CustomerVehicleSummary {
  make: string | null;
  model: string | null;
  year: string | null;
  plate: string | null;
}

export interface CustomerWithStats extends Customer {
  orders_count: number;
  // Sum of unit_price + service_price for this customer's approved orders
  // only — matches the order-total convention used everywhere else a price
  // is shown (OrderInfo.price, getOrderAnalytics, getOrderStats.
  // approvedRevenue): pending/rejected/cancelled orders never resulted in an
  // actual payment, so they don't count as money spent.
  total_spent: string;
  // Only confirmed vehicles (vehicles.status NULL/'complete') — an
  // in-progress manual-entry wizard row isn't a real vehicle yet. See the
  // VEHICLES comment in db/schema.sql.
  vehicles: CustomerVehicleSummary[];
}

// Appended to the customers SELECT in getAllCustomers/getActiveCustomerByPhone
// to attach each customer's order stats and confirmed vehicles without
// fanning out customer rows (a plain JOIN against orders/vehicles would
// duplicate the customer row per matching order/vehicle) — each LATERAL
// subquery pre-aggregates to exactly one row per customer before joining.
const CUSTOMER_STATS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS orders_count,
      COALESCE(SUM(unit_price + COALESCE(service_price, 0)) FILTER (WHERE status = 'approved'), 0) AS total_spent
    FROM orders o
    WHERE o.customer_phone = c.phone
  ) order_stats ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(
      json_build_object('make', v.make, 'model', v.model, 'year', v.year, 'plate', v.license_plate)
      ORDER BY v.created_at
    ) AS vehicles
    FROM vehicles v
    WHERE v.phone = c.phone AND (v.status IS NULL OR v.status = 'complete')
  ) vehicle_stats ON true
`;
const CUSTOMER_STATS_COLUMNS = `c.*, order_stats.orders_count, order_stats.total_spent, COALESCE(vehicle_stats.vehicles, '[]'::json) AS vehicles`;

/**
 * Lists active customers for the admin panel, newest-contact-first, with
 * optional pagination and a free-text search over name/phone/nif. Excludes
 * soft-deleted rows (see deactivateCustomer) — unlike getAllProducts/
 * getAllServices, which deliberately keep listing inactive rows so they stay
 * reachable to reactivate; customers have no such toggle-back UI today.
 */
export async function getAllCustomers({ page, limit, q }: CustomerListParams): Promise<{ customers: CustomerWithStats[]; total: number }> {
  const offset = (page - 1) * limit;
  const filters = ['c.active = true'];
  const values: unknown[] = [];

  if (q) {
    values.push(`%${q}%`);
    filters.push(`(c.name ILIKE $${values.length} OR c.phone ILIKE $${values.length} OR c.nif ILIKE $${values.length})`);
  }

  const where = `WHERE ${filters.join(' AND ')}`;

  const [{ rows: customers }, { rows: countRows }] = await Promise.all([
    db.query(
      `SELECT ${CUSTOMER_STATS_COLUMNS}
       FROM customers c
       ${CUSTOMER_STATS_JOIN}
       ${where}
       ORDER BY c.last_contact_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS count FROM customers c ${where}`, values),
  ]);

  return { customers, total: countRows[0].count };
}

/**
 * Fetches a single active customer by phone, excluding soft-deleted rows —
 * used by the admin "view individual customer" endpoint, matching the
 * active-only convention getProductById uses for products.
 */
export async function getActiveCustomerByPhone(phone: string): Promise<CustomerWithStats | null> {
  const { rows } = await db.query(
    `SELECT ${CUSTOMER_STATS_COLUMNS}
     FROM customers c
     ${CUSTOMER_STATS_JOIN}
     WHERE c.phone = $1 AND c.active = true`,
    [phone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Soft-deletes a customer (active = false) instead of a hard DELETE — vehicles.phone
 * has a non-cascading FK to customers.phone, and orders.customer_phone must keep
 * pointing at real history, so a hard delete would either violate the FK or orphan
 * order records. Mirrors the active-flag deactivation pattern used for products/suppliers.
 * Returns false if there was no active customer at that phone to delete.
 */
export async function deactivateCustomer(phone: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE customers SET active = false WHERE phone = $1 AND active = true`,
    [phone]
  );
  return (rowCount ?? 0) > 0;
}
