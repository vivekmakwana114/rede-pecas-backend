import { db } from '../config/db.js';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, downloadWhatsAppMedia } from './whatsapp.service.js';
import { generatePrimaveraInvoice, sendFinalInvoiceWhatsApp } from './pdf.service.js';
import { extractPaymentProofData } from './ai.service.js';
import { getOrderByNumber, getLatestOrderByStatus } from '../models/order.model.js';
import { getSupplierPhoneById } from '../models/supplier.model.js';
import { formatPrice } from '../utils/helpers.js';
import { t } from '../i18n/messages.js';

// Display names and instruction texts come from src/i18n/messages.ts (customer-facing);
// ids are English because they are persisted in orders.payment_method.
export const PAYMENT_METHODS = {
  BANK_TRANSFER: {
    id: 'bank_transfer',
    name: t.payment.methods.bankTransfer.name,
    emoji: '🏦',
    instructions: (orderNumber: string, amount: number) =>
      t.payment.methods.bankTransfer.instructions(orderNumber, formatPrice(amount)),
    requiresProof: true,
  },

  BANK_DEPOSIT: {
    id: 'bank_deposit',
    name: t.payment.methods.bankDeposit.name,
    emoji: '🏧',
    instructions: (orderNumber: string, amount: number) =>
      t.payment.methods.bankDeposit.instructions(orderNumber, formatPrice(amount)),
    requiresProof: true,
  },

  MULTICAIXA_EXPRESS: {
    id: 'multicaixa_express',
    name: t.payment.methods.multicaixaExpress.name,
    emoji: '📱',
    instructions: (orderNumber: string, amount: number) =>
      t.payment.methods.multicaixaExpress.instructions(orderNumber, formatPrice(amount)),
    requiresProof: true,
  },

  MOBILE_POS: {
    id: 'mobile_pos',
    name: t.payment.methods.mobilePOS.name,
    emoji: '💳',
    instructions: (orderNumber: string, amount: number) =>
      t.payment.methods.mobilePOS.instructions(orderNumber, formatPrice(amount)),
    requiresProof: false,
  },

  CASH: {
    id: 'cash',
    name: t.payment.methods.cash.name,
    emoji: '💵',
    instructions: (orderNumber: string, amount: number) =>
      t.payment.methods.cash.instructions(orderNumber, formatPrice(amount)),
    requiresProof: false,
  },
};

/**
 * Initiates the payment selection process via WhatsApp buttons.
 */
export async function askPaymentMethod(phone: string, orderNumber: string, amount: number): Promise<void> {
  const message = t.payment.askMethodBody(orderNumber, formatPrice(amount));

  await sendWhatsAppButtons(phone, message, t.payment.askMethodButtons);

  await db.query(
    `UPDATE orders SET status = 'awaiting_payment_method' WHERE number = $1`,
    [orderNumber]
  );
}

/**
 * Fetches the customer's most recent order still awaiting a payment-method
 * input, if any — used by the message pipeline to route a reply to
 * `processMethodChoice`/`processMethodSubtype` instead of the AI agent.
 */
export async function getPendingPaymentOrder(phone: string) {
  return getLatestOrderByStatus(phone, [
    'awaiting_payment_method',
    'awaiting_bank_subtype',
    'awaiting_in_person_subtype'
  ]);
}

/**
 * Processes the customer's response to the payment method list.
 */
export async function processMethodChoice(phone: string, customerReply: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT number, unit_price FROM orders
     WHERE customer_phone = $1
       AND status = 'awaiting_payment_method'
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;

  const { number, unit_price } = rows[0];
  const reply = customerReply.toLowerCase();

  if (reply.includes('transfer') || reply.includes('deposit') || reply.includes('banco') || reply === '1') {
    await sendWhatsAppButtons(phone, t.payment.askBankSubtypeBody(), t.payment.askBankSubtypeButtons);
    await db.query(
      `UPDATE orders SET status = 'awaiting_bank_subtype' WHERE number = $1`,
      [number]
    );
    return true;
  } else if (reply.includes('multicaixa') || reply.includes('express') || reply === '2') {
    await confirmMethodAndSendInstructions(phone, number, unit_price, PAYMENT_METHODS.MULTICAIXA_EXPRESS);
    return true;
  } else if (reply.includes('tpa') || reply.includes('terminal') || reply.includes('dinheiro') || reply === '3') {
    await sendWhatsAppButtons(phone, t.payment.askInPersonSubtypeBody(), t.payment.askInPersonSubtypeButtons);
    await db.query(
      `UPDATE orders SET status = 'awaiting_in_person_subtype' WHERE number = $1`,
      [number]
    );
    return true;
  } else {
    await askPaymentMethod(phone, number, unit_price);
    return true;
  }
}

/**
 * Processes banking or face-to-face payment sub-choices.
 */
export async function processMethodSubtype(phone: string, reply: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT number, unit_price, status FROM orders
     WHERE customer_phone = $1
       AND status IN ('awaiting_bank_subtype', 'awaiting_in_person_subtype')
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;

  const { number, unit_price, status } = rows[0];
  const r = reply.toLowerCase();

  let method: any;
  if (status === 'awaiting_bank_subtype') {
    method = r.includes('deposit') ? PAYMENT_METHODS.BANK_DEPOSIT : PAYMENT_METHODS.BANK_TRANSFER;
  } else {
    method = r.includes('dinheiro') || r.includes('entrega')
      ? PAYMENT_METHODS.CASH
      : PAYMENT_METHODS.MOBILE_POS;
  }

  await confirmMethodAndSendInstructions(phone, number, unit_price, method);
  return true;
}

/**
 * Saves selected payment mode and prints corresponding transactional payment steps.
 */
export async function confirmMethodAndSendInstructions(
  phone: string,
  orderNumber: string,
  amount: number,
  method: any
): Promise<void> {
  await db.query(
    `UPDATE orders
     SET payment_method = $1,
         status = $2
     WHERE number = $3`,
    [
      method.id,
      method.requiresProof ? 'awaiting_payment_proof' : 'awaiting_agent_confirmation',
      orderNumber,
    ]
  );

  await sendWhatsAppMessage(phone, method.instructions(orderNumber, amount));

  if (!method.requiresProof) {
    await notifyAgentInPersonPayment(orderNumber, phone, amount, method);
  }
}

/**
 * Saves uploaded customer receipts and flags system admins.
 */
export async function processPaymentProof(phone: string, mediaId: string, mediaType: string | null): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT number, unit_price, payment_method FROM orders
     WHERE customer_phone = $1
       AND status = 'awaiting_payment_proof'
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;

  const { number, unit_price, payment_method } = rows[0];

  // Vision can only inspect images, not PDFs — a 'document' proof skips
  // straight to acceptance below, same as before this check existed.
  if (mediaType === 'image') {
    const imageBase64 = await downloadWhatsAppMedia(mediaId);
    if (imageBase64) {
      const extracted = await extractPaymentProofData(imageBase64);
      if (extracted && extracted.valid === false) {
        logger.info(`[PAYMENT] Rejected proof for order ${number} from ${phone}: ${extracted.reason}`);
        await sendWhatsAppMessage(
          phone,
          t.payment.proofInvalid(extracted.reason || t.payment.proofInvalidDefaultReason)
        );
        return true;
      }
      if (extracted) {
        logger.info(
          `[PAYMENT] Proof extracted for order ${number}: amount=${extracted.amount} date=${extracted.date} reference=${extracted.reference}`
        );
      }
    }
  }

  await db.query(
    `UPDATE orders
     SET payment_proof_media_id = $2,
         payment_proof_media_type = $3,
         status = 'payment_proof_received',
         updated_at = NOW()
     WHERE number = $1`,
    [number, mediaId, mediaType]
  );

  const methodName = Object.values(PAYMENT_METHODS)
    .find(m => m.id === payment_method)?.name || payment_method;

  await sendWhatsAppMessage(phone, t.payment.proofReceivedCustomer(methodName, number));

  const staffPhone = config.admin.staffPhone;
  if (staffPhone) {
    await sendWhatsAppMessage(
      staffPhone,
      t.payment.proofReceivedStaff(number, methodName, formatPrice(unit_price), phone, `${config.appUrl}/admin/orders`)
    );
  }

  return true;
}

/**
 * Triggers backend transactional pipelines for validating invoice releases.
 */
export async function approveOrder(orderNumber: string, employeeId: number): Promise<any> {
  const { rows } = await db.query(
    `UPDATE orders
     SET status = 'approved', approved_by = $2, approved_at = NOW()
     WHERE number = $1
     RETURNING *`,
    [orderNumber, employeeId]
  );

  if (!rows.length) throw new Error(`Order ${orderNumber} not found`);
  const order = rows[0];

  // Fetch full details (joins part and supplier)
  const details = await getOrderByNumber(orderNumber);
  const fullOrder = details ? { ...order, ...details } : order;

  // Generate tax invoice PDF
  const invoicePDF = await generatePrimaveraInvoice(fullOrder);

  // Send the final PDF invoice to the customer
  await sendFinalInvoiceWhatsApp(order.customer_phone, invoicePDF, orderNumber);

  // Notify the supplier to prepare delivery
  await notifySupplierDelivery(fullOrder);

  return { success: true, orderNumber };
}

/**
 * Confirms non-banking payment choices and bypasses receipt checks.
 */
export async function confirmInPersonPayment(orderNumber: string, employeeId: number, method: string): Promise<void> {
  await db.query(
    `UPDATE orders
     SET status = 'payment_proof_received',
         payment_method = $2
     WHERE number = $1`,
    [orderNumber, method]
  );

  await approveOrder(orderNumber, employeeId);
}

/**
 * Notifies the internal team member about a physical payment request.
 */
async function notifyAgentInPersonPayment(
  orderNumber: string,
  customerPhone: string,
  amount: number,
  method: any
): Promise<void> {
  const staffPhone = config.admin.staffPhone;
  if (!staffPhone) return;

  await sendWhatsAppMessage(
    staffPhone,
    t.payment.inPersonPaymentStaff(
      orderNumber,
      method.name,
      method.emoji,
      formatPrice(amount),
      customerPhone,
      method.id === 'mobile_pos',
      `${config.appUrl}/admin/orders`
    )
  );
}

/**
 * Dispatches a delivery checklist alert to the supplier.
 */
async function notifySupplierDelivery(order: any): Promise<void> {
  const supplierPhone = await getSupplierPhoneById(order.supplier_id);
  if (!supplierPhone) return;

  try {
    await sendWhatsAppMessage(
      supplierPhone,
      t.payment.supplierDeliveryNotice(order.product_name, order.reference, order.quantity, order.number)
    );
  } catch (error: any) {
    // Delivery notification must not fail the approval flow
    logger.error(`Error notifying supplier for delivery: ${error.message}`);
  }
}
