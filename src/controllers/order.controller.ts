import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import {
  getOrdersPendingApproval,
  getOrdersApprovedToday,
  getOrdersPendingStockConfirmation,
  updateOrderStatus,
  getOrderByNumber,
} from '../models/order.model.js';
import { approveOrder } from '../services/payment.service.js';
import { confirmStockAndFinalizeOrder, markStockUnavailableAndOfferAlternative } from '../services/product.service.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';
import { t } from '../i18n/messages.js';

/**
 * Returns pending approvals, current-day approved logs, and orders awaiting
 * stock-with-supplier confirmation to the dashboard/queues.
 */
export const getOrders = catchAsync(async (req: Request, res: Response) => {
  const pending = await getOrdersPendingApproval();
  const approved = await getOrdersApprovedToday();
  const stockConfirmation = await getOrdersPendingStockConfirmation();

  res.status(200).json({
    success: true,
    message: 'Orders retrieved.',
    code: 200,
    data: { pending, approved, stockConfirmation },
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin confirms the supplier has the item in stock — generates and sends the
 * proforma, then kicks off the payment-method flow with the customer.
 */
export const confirmOrderStockHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  await confirmStockAndFinalizeOrder(number);

  res.status(200).json({
    success: true,
    message: `Stock confirmed for order ${number}.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Admin declines stock availability — no payment was ever taken. Notifies the
 * customer and offers a fresh search for alternatives or the waitlist.
 */
export const markOrderStockUnavailableHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  await markStockUnavailableAndOfferAlternative(number);

  res.status(200).json({
    success: true,
    message: `Order ${number} marked stock-unavailable.`,
    code: 200,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Approves a customer order, generates the tax invoice, and triggers supplier dispatch notifications.
 */
export const approveOrderHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
  const result = await approveOrder(number, 999); // Mock employee ID '999' or 'admin'

  res.status(200).json({
    success: true,
    message: `Order ${number} approved.`,
    code: 200,
    data: result,
    meta: { timestamp: new Date().toISOString() },
  });
});

/**
 * Rejects a customer order and alerts the user about proof validation failure.
 */
export const rejectOrderHandler = catchAsync(async (req: Request, res: Response) => {
  const { number } = req.params;
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
