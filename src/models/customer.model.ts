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
