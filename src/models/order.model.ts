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
