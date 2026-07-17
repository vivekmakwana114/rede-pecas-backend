import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import {
  getOrdersPendingApproval,
  getOrdersApproved,
  getOrdersRejected,
  getOrdersPendingStockConfirmation,
  updateOrderStatus,
  getOrderByNumber,
  getOrderAnalytics,
  AnalyticsPeriod,
  getOrderStats,
} from '../models/order.model.js';
import { approveOrder } from '../services/payment.service.js';
import { confirmStockAndFinalizeOrder, markStockUnavailableAndOfferAlternative } from '../services/product.service.js';
import { resolveMessages } from '../services/customer.service.js';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '../services/whatsapp.service.js';

/**
 * Returns pending approvals, approved/rejected logs, and orders awaiting
 * stock-with-supplier confirmation to the dashboard/queues. `pending` is
 * always the first key in `data` so the admin panel sees the newest
 * actionable orders first. `?range=today|all` (default 'all') scopes the
 * approved/rejected logs — pending/stockConfirmation are always "all
 * currently open", never date-scoped.
 */
export const getOrders = catchAsync(async (req: Request, res: Response) => {
  const range = (req.query.range as 'today' | 'all') || 'all';
  const [pending, approved, rejected, stockConfirmation] = await Promise.all([
    getOrdersPendingApproval(),
    getOrdersApproved(range),
    getOrdersRejected(range),
    getOrdersPendingStockConfirmation(),
  ]);

  res.status(200).json({
    success: true,
    message: 'Orders retrieved.',
    code: 200,
    data: { pending, approved, rejected, stockConfirmation },
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin's stock-with-supplier decision. `available: true` confirms stock —
 * generates and sends the proforma, then kicks off the payment-method flow
 * with the customer. `available: false` declines availability — no payment
 * was ever taken; notifies the customer and offers a fresh search for
 * alternatives or the waitlist.
 */
export const confirmOrderStockHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const { available } = req.body;

  if (available) {
    await confirmStockAndFinalizeOrder(number);
  } else {
    await markStockUnavailableAndOfferAlternative(number);
  }

  res.status(200).json({
    success: true,
    message: available ? `Stock confirmed for order ${number}.` : `Order ${number} marked stock-unavailable.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin's approve/reject decision on a customer order. `approved: true`
 * generates the tax invoice and triggers supplier dispatch notifications.
 * `approved: false` alerts the customer about proof validation failure.
 */
export const reviewOrderHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const { approved } = req.body;

  if (approved) {
    const result = await approveOrder(number, 999); // Mock employee ID '999' or 'admin'

    res.status(200).json({
      success: true,
      message: `Order ${number} approved.`,
      code: 200,
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
    return;
  }

  await updateOrderStatus(number, 'rejected');

  // Notify customer about rejection via WhatsApp, in their own detected locale
  const order = await getOrderByNumber(number);
  if (order) {
    const messages = await resolveMessages(order.customer_phone);
    await sendWhatsAppMessage(order.customer_phone, messages.order.rejected(number));
  }

  res.status(200).json({
    success: true,
    message: `Order ${number} rejected.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Time-bucketed revenue/order-count series for the dashboard's Revenue and
 * Orders charts — one point per hour (daily), day (monthly), or month
 * (yearly). See getOrderAnalytics in order.model.ts for the bucketing rules.
 */
export const getOrderAnalyticsHandler = catchAsync(async (req: Request, res: Response) => {
  const period = req.query.period as AnalyticsPeriod;
  const points = await getOrderAnalytics(period);

  res.status(200).json({
    success: true,
    message: 'Order analytics retrieved.',
    code: 200,
    data: { points },
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * All-time order totals (not scoped to today) for the dashboard's stat
 * cards — see getOrderStats in order.model.ts for why this is a separate
 * query from the today-scoped /orders queues.
 */
export const getOrderStatsHandler = catchAsync(async (req: Request, res: Response) => {
  const stats = await getOrderStats();

  res.status(200).json({
    success: true,
    message: 'Order stats retrieved.',
    code: 200,
    data: stats,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Details of a single order, joined with product/supplier — the admin
 * panel's individual order view.
 */
export const getOrderHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const order = await getOrderByNumber(number);
  if (!order) throw new ApiError(404, `Order ${number} not found`);

  res.status(200).json({
    success: true,
    message: 'Order retrieved.',
    code: 200,
    data: order,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Soft-deletes an order by moving it to a 'cancelled' terminal status rather
 * than a hard DELETE — admin_alerts.order_number has a non-cascading FK to
 * orders.number, and an order is a financial/audit record that should stay
 * queryable after the fact. Only allowed from a non-terminal status: an
 * already-approved order represents a completed sale (cancelling that would
 * need a real refund flow, which is out of scope — see CLAUDE.md), and an
 * already-rejected/cancelled order has nothing left to cancel.
 */
export const deleteOrderHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const order = await getOrderByNumber(number);
  if (!order) throw new ApiError(404, `Order ${number} not found`);

  if (order.status === 'approved') {
    throw new ApiError(409, `Order ${number} is already approved and cannot be cancelled`);
  }
  if (order.status === 'rejected' || order.status === 'cancelled') {
    throw new ApiError(409, `Order ${number} is already ${order.status}`);
  }

  await updateOrderStatus(number, 'cancelled');

  res.status(200).json({
    success: true,
    message: `Order ${number} cancelled.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Streams the customer's uploaded payment-proof photo/PDF straight from
 * Meta's WhatsApp Cloud API so the admin panel can render it for review —
 * nothing is stored on our own infrastructure, only Meta's media_id
 * (savePaymentProof in order.model.ts), so this re-downloads the bytes fresh
 * on every call via the same downloadWhatsAppMedia used during proof
 * validation (payment.service.ts). This is a deliberate second exception to
 * the standard JSON envelope (the first being the WhatsApp webhook routes)
 * since binary bytes can't usefully be wrapped in JSON.
 */
export const getPaymentProofHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const order = await getOrderByNumber(number);
  if (!order) throw new ApiError(404, `Order ${number} not found`);
  if (!order.payment_proof_media_id) throw new ApiError(404, `Order ${number} has no payment proof on file`);

  const fileBase64 = await downloadWhatsAppMedia(order.payment_proof_media_id);
  if (!fileBase64) throw new ApiError(502, `Could not fetch payment proof for order ${number} from WhatsApp`);

  res.set('Content-Type', order.payment_proof_media_type === 'document' ? 'application/pdf' : 'image/jpeg');
  res.send(Buffer.from(fileBase64, 'base64'));
});
