import { Request, Response } from 'express';
import { logger } from '../config/logger.js';
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
export async function getOrders(req: Request, res: Response): Promise<void> {
  try {
    const pending = await getOrdersPendingApproval();
    const approved = await getOrdersApprovedToday();
    res.json({ pending, approved });
  } catch (error: any) {
    logger.error('Error fetching admin dashboard orders data', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Approves a customer order, generates the tax invoice, and triggers supplier dispatch notifications.
 */
export async function approveOrderHandler(req: Request, res: Response): Promise<void> {
  const { number } = req.params;

  try {
    const result = await approveOrder(number, 999); // Mock employee ID '999' or 'admin'
    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error(`Error approving order ${number}`, error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Rejects a customer order and alerts the user about proof validation failure.
 */
export async function rejectOrderHandler(req: Request, res: Response): Promise<void> {
  const { number } = req.params;

  try {
    await updateOrderStatus(number, 'rejected');

    // Notify customer about rejection via WhatsApp
    const order = await getOrderByNumber(number);
    if (order) {
      await sendWhatsAppMessage(order.customer_phone, t.order.rejected(number));
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Error rejecting order ${number}`, error);
    res.status(500).json({ error: error.message });
  }
}
