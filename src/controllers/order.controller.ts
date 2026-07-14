import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import {
  getOrdersPendingApproval,
  getOrdersApprovedToday,
  getOrdersRejectedToday,
  getOrdersPendingStockConfirmation,
  updateOrderStatus,
  getOrderByNumber,
} from '../models/order.model.js';
import { approveOrder } from '../services/payment.service.js';
import { confirmStockAndFinalizeOrder, markStockUnavailableAndOfferAlternative } from '../services/product.service.js';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '../services/whatsapp.service.js';
import { t } from '../i18n/messages.js';

/**
 * Returns pending approvals, current-day approved/rejected logs, and orders
 * awaiting stock-with-supplier confirmation to the dashboard/queues. `pending`
 * is always the first key in `data` so the admin panel sees the newest
 * actionable orders first.
 */
export const getOrders = catchAsync(async (req: Request, res: Response) => {
  const [pending, approved, rejected, stockConfirmation] = await Promise.all([
    getOrdersPendingApproval(),
    getOrdersApprovedToday(),
    getOrdersRejectedToday(),
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

  // Notify customer about rejection via WhatsApp
  const order = await getOrderByNumber(number);
  if (order) {
    await sendWhatsAppMessage(order.customer_phone, t.order.rejected(number));
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
