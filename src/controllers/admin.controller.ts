import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { db } from '../config/db.js';
import {
  getOrdersPendingApproval,
  getOrdersApprovedToday,
  updateOrderStatus,
  importPartsBatch
} from '../models/inventory.model.js';
import { approveOrder } from '../services/payment.service.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';

/**
 * Secures panel accesses by delivering session credentials based on the admin password.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { password } = req.body;

  if (password !== config.admin.password) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  // Create JWT token for admin session
  const token = jwt.sign({ role: 'admin' }, config.jwt.secret, {
    expiresIn: `${config.jwt.accessExpirationMinutes}m`,
  });

  res.json({ token });
}

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

    // Notify customer about rejection via WhatsApp (customer message stays Portuguese)
    const { rows } = await db.query(
      'SELECT customer_phone FROM orders WHERE number = $1',
      [number]
    );

    if (rows.length) {
      const phone = rows[0].customer_phone;
      await sendWhatsAppMessage(
        phone,
        `❌ O teu pedido *${number}* foi rejeitado.\n\n` +
        `Motivo: comprovativo de pagamento não confirmado ou inválido.\n\n` +
        `Se achas que é um erro, responde aqui e um atendente irá ajudar-te. 🙏`
      );
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Error rejecting order ${number}`, error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Bulk imports spreadsheet rows mapped to supplier items.
 */
export async function importPartsBatchHandler(req: Request, res: Response): Promise<void> {
  const { supplierId, items } = req.body;

  if (!supplierId || !Array.isArray(items)) {
    res.status(400).json({ error: 'Invalid parameters. supplierId and items are required.' });
    return;
  }

  try {
    const result = await importPartsBatch(supplierId, items);
    res.json(result);
  } catch (error: any) {
    logger.error(`Error importing batch parts for supplier ${supplierId}`, error);
    res.status(500).json({ error: error.message });
  }
}
