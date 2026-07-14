import { db } from '../config/db.js';
import { Product } from './product.model.js';

export interface OrderInfo {
  number: string;
  customer: string;
  part: string;
  reference: string;
  supplier: string;
  price: number;
  created_at: Date;
  time: string;
  has_proof: boolean;
  payment_method?: string;
  requires_proof?: boolean;
  service_name?: string;
  service_price?: number;
}

/**
 * Inserts a new order into the orders log.
 */
export async function createOrder(
  orderNumber: string,
  phone: string,
  item: Product
): Promise<void> {
  await db.query(
    `INSERT INTO orders (number, customer_phone, product_id, supplier_id, quantity, unit_price, status, created_at)
     VALUES ($1, $2, $3, $4, 1, $5, 'awaiting_payment', NOW())`,
    [orderNumber, phone, item.id, item.supplier_id, item.price]
  );
}

/**
 * Attaches the accepted product service to an order as a price snapshot —
 * called once the customer replies "sim" to the service follow-up offer.
 */
export async function addServiceToOrder(orderNumber: string, serviceName: string, servicePrice: number): Promise<void> {
  await db.query(
    `UPDATE orders SET service_name = $2, service_price = $3, updated_at = NOW() WHERE number = $1`,
    [orderNumber, serviceName, servicePrice]
  );
}

/**
 * Fetches last pending order waiting for billing selection or verification.
 */
export async function getLatestOrderByStatus(phone: string, statuses: string[]): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM orders
     WHERE customer_phone = $1
       AND status = ANY($2::text[])
     ORDER BY created_at DESC LIMIT 1`,
    [phone, statuses]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates status of a given order.
 */
export async function updateOrderStatus(orderNumber: string, status: string, additionalFields: any = {}): Promise<void> {
  const setClauses = [`status = $2`, `updated_at = NOW()`];
  const params: any[] = [orderNumber, status];

  if (additionalFields.approved_by) {
    setClauses.push(`approved_by = $${setClauses.length + 2}`);
    params.push(additionalFields.approved_by);
    setClauses.push(`approved_at = NOW()`);
  }

  if (additionalFields.payment_method) {
    setClauses.push(`payment_method = $${setClauses.length + 2}`);
    params.push(additionalFields.payment_method);
  }

  await db.query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE number = $1`,
    params
  );
}

/**
 * Registers customer payment proof metadata on the order.
 */
export async function savePaymentProof(orderNumber: string, mediaId: string, mediaType: string | null = null): Promise<void> {
  await db.query(
    `UPDATE orders
     SET payment_proof_media_id = $2,
         payment_proof_media_type = $3,
         updated_at = NOW()
     WHERE number = $1`,
    [orderNumber, mediaId, mediaType]
  );
}

/**
 * Increments and issues a unique order document serial (RP-YYYY-XXXXX).
 */
export async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const result = await db.query(
    `INSERT INTO order_counters (year, last_number)
     VALUES ($1, 1)
     ON CONFLICT (year)
     DO UPDATE SET last_number = order_counters.last_number + 1
     RETURNING last_number`,
    [year]
  );
  const sequence = result.rows[0].last_number;
  return `RP-${year}-${String(sequence).padStart(5, "0")}`;
}

/**
 * Retrieves orders awaiting approval.
 */
export async function getOrdersPendingApproval(): Promise<OrderInfo[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price, o.created_at,
      o.service_name, o.service_price,
      p.name AS part, p.reference,
      s.name AS supplier,
      o.payment_method,
      to_char(o.created_at, 'HH24:MI') AS time,
      (o.payment_proof_media_id IS NOT NULL) AS has_proof,
      (o.payment_method = 'bank_transfer' OR o.payment_method = 'bank_deposit' OR o.payment_method = 'multicaixa_express') AS requires_proof
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN suppliers s ON s.id = o.supplier_id
    WHERE o.status IN ('awaiting_payment', 'payment_proof_received', 'awaiting_payment_proof', 'awaiting_agent_confirmation')
    ORDER BY o.created_at DESC
  `);
  return rows;
}

/**
 * Retrieves orders awaiting the admin's stock-with-supplier confirmation
 * (the panel's dedicated queue — see order.controller.ts). waiting_minutes
 * lets the panel flag anything over 15 minutes itself; there's no backend
 * timer/reminder for this since it's admin-panel-only, not a WhatsApp push.
 */
export async function getOrdersPendingStockConfirmation(): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price, o.created_at,
      o.service_name, o.service_price,
      p.id AS product_id, p.name AS part, p.reference,
      s.name AS supplier,
      EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60 AS waiting_minutes
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN suppliers s ON s.id = o.supplier_id
    WHERE o.status = 'awaiting_stock_confirmation'
    ORDER BY o.created_at ASC
  `);
  return rows;
}

/**
 * Orders that have been sitting in awaiting_stock_confirmation past
 * `minMinutes` and haven't had the customer courtesy message sent yet —
 * polled by the sweep in product.service.ts.
 */
export async function getOrdersAwaitingCourtesyMessage(minMinutes: number): Promise<{ number: string; customer_phone: string }[]> {
  const { rows } = await db.query(
    `SELECT number, customer_phone FROM orders
     WHERE status = 'awaiting_stock_confirmation'
       AND stock_confirmation_courtesy_sent = false
       AND created_at < NOW() - ($1 || ' minutes')::interval`,
    [minMinutes]
  );
  return rows;
}

export async function markCourtesyMessageSent(orderNumber: string): Promise<void> {
  await db.query(
    `UPDATE orders SET stock_confirmation_courtesy_sent = true WHERE number = $1`,
    [orderNumber]
  );
}

/**
 * Orders that have been sitting in awaiting_stock_confirmation past
 * `minMinutes` and haven't had the admin SLA-reminder WhatsApp nudge sent yet —
 * polled by the sweep in product.service.ts. Same shape as
 * getOrdersAwaitingCourtesyMessage above, joined for the product name and
 * customer's first name needed in the reminder text.
 */
export async function getOrdersAwaitingAdminReminder(minMinutes: number): Promise<{ number: string; product_name: string; customer_first_name: string }[]> {
  const { rows } = await db.query(
    `SELECT o.number, p.name AS product_name,
            COALESCE(split_part(c.name, ' ', 1), 'Cliente') AS customer_first_name
     FROM orders o
     JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c ON c.phone = o.customer_phone
     WHERE o.status = 'awaiting_stock_confirmation'
       AND o.stock_confirmation_admin_reminder_sent = false
       AND o.created_at < NOW() - ($1 || ' minutes')::interval`,
    [minMinutes]
  );
  return rows;
}

export async function markAdminReminderSent(orderNumber: string): Promise<void> {
  await db.query(
    `UPDATE orders SET stock_confirmation_admin_reminder_sent = true WHERE number = $1`,
    [orderNumber]
  );
}

/**
 * Retrieves orders approved on the current date.
 */
export async function getOrdersApprovedToday(): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price,
      p.name AS part,
      to_char(o.approved_at, 'HH24:MI') AS time
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.status = 'approved'
      AND o.approved_at::date = CURRENT_DATE
    ORDER BY o.approved_at DESC
  `);
  return rows;
}

/**
 * Details of a single order.
 */
export async function getOrderByNumber(number: string): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT o.*, p.name AS product_name, p.reference, s.name AS supplier_name
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.number = $1`,
    [number]
  );
  return rows.length ? rows[0] : null;
}
