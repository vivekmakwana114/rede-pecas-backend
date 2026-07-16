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
  payment_proof_media_type?: string | null;
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
      o.payment_proof_media_type,
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
      to_char(o.approved_at, 'HH24:MI') AS time,
      (o.payment_proof_media_id IS NOT NULL) AS has_proof,
      o.payment_proof_media_type
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.status = 'approved'
      AND o.approved_at::date = CURRENT_DATE
    ORDER BY o.approved_at DESC
  `);
  return rows;
}

/**
 * Retrieves orders rejected on the current date. There's no dedicated
 * rejected_at column (rejection just sets status via updateOrderStatus),
 * so updated_at is used as the rejection timestamp — same idiom as
 * approved_at above for the approved queue.
 */
export async function getOrdersRejectedToday(): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      o.number, o.customer_phone AS customer,
      o.unit_price AS price,
      p.name AS part,
      to_char(o.updated_at, 'HH24:MI') AS time,
      (o.payment_proof_media_id IS NOT NULL) AS has_proof,
      o.payment_proof_media_type
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.status = 'rejected'
      AND o.updated_at::date = CURRENT_DATE
    ORDER BY o.updated_at DESC
  `);
  return rows;
}

export type AnalyticsPeriod = 'daily' | 'monthly' | 'yearly';

export interface AnalyticsPoint {
  label: string;
  revenue: string;
  pending: number;
  approved: number;
  rejected: number;
  stockConfirmation: number;
}

// Range/bucket shape per period for the admin dashboard charts — daily buckets
// by hour (today), monthly by day (this calendar month), yearly by month
// (this calendar year). rangeStartExpr/rangeEndExpr are trusted SQL snippets
// (not user input — period is constrained to these three keys by the Joi
// validation before this is ever called), interpolated directly into the
// query text since date/interval expressions can't be bound as query params.
const ANALYTICS_PERIOD_CONFIG: Record<AnalyticsPeriod, {
  rangeStartExpr: string;
  rangeEndExpr: string;
  step: string;
  truncUnit: string;
  labelFormat: string;
}> = {
  daily: {
    rangeStartExpr: `date_trunc('day', NOW())`,
    rangeEndExpr: `date_trunc('day', NOW()) + interval '23 hours'`,
    step: '1 hour',
    truncUnit: 'hour',
    labelFormat: 'HH24:00',
  },
  monthly: {
    rangeStartExpr: `date_trunc('month', NOW())`,
    rangeEndExpr: `date_trunc('month', NOW()) + interval '1 month' - interval '1 day'`,
    step: '1 day',
    truncUnit: 'day',
    labelFormat: 'DD Mon',
  },
  yearly: {
    rangeStartExpr: `date_trunc('year', NOW())`,
    rangeEndExpr: `date_trunc('year', NOW()) + interval '11 months'`,
    step: '1 month',
    truncUnit: 'month',
    labelFormat: 'Mon',
  },
};

/**
 * Buckets orders into one point per hour/day/month (depending on `period`)
 * for the admin dashboard's revenue/orders charts. Every bucket in the range
 * is included even when empty (0 revenue, 0 counts) via the generate_series
 * CTE left-joined to the actual order rows, so the X axis is always a
 * complete, evenly-spaced today/this-month/this-year — not just the hours/
 * days/months that happen to have orders.
 *
 * Bucketed by created_at (when the order was placed), not approved_at/
 * updated_at — keeps both charts on the same X axis and revenue attributed
 * to when the sale started, not when the admin got around to approving it.
 *
 * revenue sums unit_price only (not service_price), matching the existing
 * "Revenue (Approved)" convention elsewhere (OrderInfo.price / StatsGrid).
 * stock_unavailable and cancelled orders are excluded from every status
 * bucket — same as the live /orders queues, which also drop them.
 */
export async function getOrderAnalytics(period: AnalyticsPeriod): Promise<AnalyticsPoint[]> {
  const { rangeStartExpr, rangeEndExpr, step, truncUnit, labelFormat } = ANALYTICS_PERIOD_CONFIG[period];

  const { rows } = await db.query(
    `WITH buckets AS (
       SELECT generate_series(${rangeStartExpr}, ${rangeEndExpr}, $1::interval) AS bucket_start
     ),
     order_stats AS (
       SELECT date_trunc('${truncUnit}', created_at) AS bucket_start, status, unit_price
       FROM orders
       WHERE created_at >= ${rangeStartExpr}
         AND created_at < ${rangeEndExpr} + $1::interval
     )
     SELECT
       to_char(b.bucket_start, $2) AS label,
       COALESCE(SUM(o.unit_price) FILTER (WHERE o.status = 'approved'), 0) AS revenue,
       COUNT(*) FILTER (WHERE o.status = 'approved')::int AS approved,
       COUNT(*) FILTER (WHERE o.status = 'rejected')::int AS rejected,
       COUNT(*) FILTER (WHERE o.status = 'awaiting_stock_confirmation')::int AS "stockConfirmation",
       COUNT(*) FILTER (
         WHERE o.status NOT IN ('approved', 'rejected', 'awaiting_stock_confirmation', 'cancelled', 'stock_unavailable')
       )::int AS pending
     FROM buckets b
     LEFT JOIN order_stats o ON o.bucket_start = b.bucket_start
     GROUP BY b.bucket_start
     ORDER BY b.bucket_start`,
    [step, labelFormat]
  );

  return rows;
}

export interface OrderStats {
  totalOrders: number;
  approvedOrders: number;
  rejectedOrders: number;
  approvedRevenue: string;
}

/**
 * All-time platform totals for the dashboard's stat cards — deliberately
 * separate from getOrdersApprovedToday/getOrdersRejectedToday above, which
 * are scoped to CURRENT_DATE on purpose for the Orders queue page's daily
 * log. totalOrders counts every order row regardless of status (including
 * cancelled/stock_unavailable — still a real order that was placed), while
 * approvedRevenue sums unit_price only, matching the existing
 * "Revenue (Approved)" convention (OrderInfo.price / getOrderAnalytics).
 */
export async function getOrderStats(): Promise<OrderStats> {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int AS "totalOrders",
      COUNT(*) FILTER (WHERE status = 'approved')::int AS "approvedOrders",
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS "rejectedOrders",
      COALESCE(SUM(unit_price) FILTER (WHERE status = 'approved'), 0) AS "approvedRevenue"
    FROM orders
  `);
  return rows[0];
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
