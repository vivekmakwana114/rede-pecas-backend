import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import {
  getOrdersPendingApproval,
  getOrdersApprovedToday,
  updateOrderStatus,
  getOrderByNumber,
} from '../models/order.model.js';
import { approveOrder } from '../services/payment.service.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';
import { t } from '../i18n/messages.js';

/**
 * Returns pending approvals and current-day approved logs to the dashboard charts.
 */
export const getOrders = catchAsync(async (req: Request, res: Response) => {
  const pending = await getOrdersPendingApproval();
  const approved = await getOrdersApprovedToday();

  res.status(200).json({
    success: true,
    message: 'Orders retrieved.',
    code: 200,
    data: { pending, approved },
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
