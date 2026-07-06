import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import {
  getOrdersPendingApproval,
  getOrdersApprovedToday,
  updateOrderStatus,
  getOrderByNumber,
} from '../models/order.model.js';
import { importProductsBatch, getOrCreateSupplierByName } from '../models/supplier.model.js';
import { approveOrder } from '../services/payment.service.js';
import { sendWhatsAppMessage } from '../services/whatsapp.service.js';
import { notifyWaitlistedCustomers } from '../services/product.service.js';
import { t } from '../i18n/messages.js';

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

/**
 * Bulk imports spreadsheet rows mapped to supplier items.
 */
export async function importProductsBatchHandler(req: Request, res: Response): Promise<void> {
  const { supplierId, items } = req.body;

  if (!supplierId || !Array.isArray(items)) {
    res.status(400).json({ error: 'Invalid parameters. supplierId and items are required.' });
    return;
  }

  try {
    const result = await importProductsBatch(supplierId, items);
    await notifyWaitlistedCustomers(result.restockNotifications);
    res.json(result);
  } catch (error: any) {
    logger.error(`Error importing batch products for supplier ${supplierId}`, error);
    res.status(500).json({ error: error.message });
  }
}

const HEADER_ALIASES: Record<string, string[]> = {
  reference: ['reference', 'referencia', 'ref', 'sku'],
  name: ['name', 'nome', 'descricao', 'description', 'descrição'],
  price: ['price', 'preco', 'preço'],
  quantity: ['quantity', 'quantidade', 'qty', 'stock'],
};

function normalizeRow(row: Record<string, any>): { reference: string; name: string; price: number; quantity: number } | null {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined) return lowerRow[alias];
    }
    return undefined;
  };
  const reference = pick('reference');
  const name = pick('name');
  const price = Number(pick('price'));
  const quantity = Number(pick('quantity'));
  if (!reference || !name || Number.isNaN(price) || Number.isNaN(quantity)) return null;
  return { reference: String(reference), name: String(name), price, quantity };
}

/**
 * Bulk imports products from an uploaded CSV/XLSX file, parsed server-side.
 * Accepts either an existing supplierId or supplier name/nif/province to
 * create one on the fly.
 */
export async function importProductsFileHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'File is required (field name: file).' });
    return;
  }

  const { supplierId, supplierName, supplierNif, supplierProvince } = req.body;

  try {
    const resolvedSupplierId = supplierId
      ? Number(supplierId)
      : await getOrCreateSupplierByName(supplierName, supplierNif, supplierProvince);

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);

    const items = rawRows
      .map(normalizeRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const result = await importProductsBatch(resolvedSupplierId, items);
    await notifyWaitlistedCustomers(result.restockNotifications);

    res.json({ supplierId: resolvedSupplierId, ...result });
  } catch (error: any) {
    logger.error('Error importing inventory file', error);
    res.status(500).json({ error: error.message });
  }
}
