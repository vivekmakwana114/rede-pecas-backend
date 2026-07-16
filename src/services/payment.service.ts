import { db } from '../config/db.js';
import { logger } from '../config/logger.js';
import { sendWhatsAppMessage, sendWhatsAppButtons, downloadWhatsAppMedia } from './whatsapp.service.js';
import { generatePrimaveraInvoice, sendFinalInvoiceWhatsApp } from './pdf.service.js';
import { extractPaymentProofData } from './ai.service.js';
import { getOrderByNumber, getLatestOrderByStatus, updateOrderStatus } from '../models/order.model.js';
import { getSupplierPhoneById } from '../models/supplier.model.js';
import { getCustomerByPhone } from '../models/customer.model.js';
import { getAllAdmins, getAdminByPhone } from '../models/adminUser.model.js';
import { createAlert } from '../models/alert.model.js';
import { formatPrice } from '../utils/helpers.js';
import { t, getMessages, DEFAULT_LOCALE } from '../i18n/messages.js';
import { resolveMessages } from './customer.service.js';

// Display names and instruction texts come from src/i18n/messages.ts (customer-facing);
// ids are English because they are persisted in orders.payment_method. A function
// rather than a module-level constant so it can be built per-customer-locale — it used
// to be built once at import time off the fixed `t`, which meant every customer saw
// payment method names/instructions in whatever the process-wide MESSAGE_LOCALE was,
// regardless of their own detected locale.
export function getPaymentMethods(locale: 'pt' | 'en') {
  const messages = getMessages(locale);
  return {
    BANK_TRANSFER: {
      id: 'bank_transfer',
      name: messages.payment.methods.bankTransfer.name,
      emoji: '🏦',
      instructions: (orderNumber: string, amount: number) =>
        messages.payment.methods.bankTransfer.instructions(orderNumber, formatPrice(amount)),
      requiresProof: true,
    },

    BANK_DEPOSIT: {
      id: 'bank_deposit',
      name: messages.payment.methods.bankDeposit.name,
      emoji: '🏧',
      instructions: (orderNumber: string, amount: number) =>
        messages.payment.methods.bankDeposit.instructions(orderNumber, formatPrice(amount)),
      requiresProof: true,
    },

    MULTICAIXA_EXPRESS: {
      id: 'multicaixa_express',
      name: messages.payment.methods.multicaixaExpress.name,
      emoji: '📱',
      instructions: (orderNumber: string, amount: number) =>
        messages.payment.methods.multicaixaExpress.instructions(orderNumber, formatPrice(amount)),
      requiresProof: true,
    },

    MOBILE_POS: {
      id: 'mobile_pos',
      name: messages.payment.methods.mobilePOS.name,
      emoji: '💳',
      instructions: (orderNumber: string, amount: number) =>
        messages.payment.methods.mobilePOS.instructions(orderNumber, formatPrice(amount)),
      requiresProof: false,
    },

    CASH: {
      id: 'cash',
      name: messages.payment.methods.cash.name,
      emoji: '💵',
      instructions: (orderNumber: string, amount: number) =>
        messages.payment.methods.cash.instructions(orderNumber, formatPrice(amount)),
      requiresProof: false,
    },
  };
}

/**
 * Initiates the payment selection process via WhatsApp buttons.
 */
export async function askPaymentMethod(phone: string, orderNumber: string, amount: number): Promise<void> {
  const messages = await resolveMessages(phone);
  const message = messages.payment.askMethodBody(orderNumber, formatPrice(amount));

  await sendWhatsAppButtons(phone, message, messages.payment.askMethodButtons);

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
  const locale = (await getCustomerByPhone(phone))?.locale ?? DEFAULT_LOCALE;
  const messages = getMessages(locale);
  const paymentMethods = getPaymentMethods(locale);
  const { rows } = await db.query(
    `SELECT number, unit_price, service_price FROM orders
     WHERE customer_phone = $1
       AND status = 'awaiting_payment_method'
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;

  const { number, unit_price, service_price } = rows[0];
  const amount = Number(unit_price) + Number(service_price || 0);
  const reply = customerReply.toLowerCase();

  if (reply.includes('transfer') || reply.includes('deposit') || reply.includes('depósito') || reply.includes('banco') || reply.includes('bank') || reply === '1') {
    await sendWhatsAppButtons(phone, messages.payment.askBankSubtypeBody(), messages.payment.askBankSubtypeButtons);
    await db.query(
      `UPDATE orders SET status = 'awaiting_bank_subtype' WHERE number = $1`,
      [number]
    );
    return true;
  } else if (reply.includes('multicaixa') || reply.includes('express') || reply === '2') {
    await confirmMethodAndSendInstructions(phone, number, amount, paymentMethods.MULTICAIXA_EXPRESS);
    return true;
  } else if (reply.includes('tpa') || reply.includes('terminal') || reply.includes('dinheiro') || reply === '3') {
    await sendWhatsAppButtons(phone, messages.payment.askInPersonSubtypeBody(), messages.payment.askInPersonSubtypeButtons);
    await db.query(
      `UPDATE orders SET status = 'awaiting_in_person_subtype' WHERE number = $1`,
      [number]
    );
    return true;
  } else {
    await askPaymentMethod(phone, number, amount);
    return true;
  }
}

/**
 * Processes banking or face-to-face payment sub-choices.
 */
export async function processMethodSubtype(phone: string, reply: string): Promise<boolean> {
  const locale = (await getCustomerByPhone(phone))?.locale ?? DEFAULT_LOCALE;
  const paymentMethods = getPaymentMethods(locale);
  const { rows } = await db.query(
    `SELECT number, unit_price, service_price, status FROM orders
     WHERE customer_phone = $1
       AND status IN ('awaiting_bank_subtype', 'awaiting_in_person_subtype')
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;

  const { number, unit_price, service_price, status } = rows[0];
  const amount = Number(unit_price) + Number(service_price || 0);
  const r = reply.toLowerCase();

  let method: any;
  if (status === 'awaiting_bank_subtype') {
    method = (r.includes('deposit') || r.includes('depósito')) ? paymentMethods.BANK_DEPOSIT : paymentMethods.BANK_TRANSFER;
  } else {
    method = r.includes('dinheiro') || r.includes('entrega')
      ? paymentMethods.CASH
      : paymentMethods.MOBILE_POS;
  }

  await confirmMethodAndSendInstructions(phone, number, amount, method);
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
 * Saves uploaded customer receipts and flags system admins. Both photos and
 * PDFs are examined by Claude Vision (extractPaymentProofData) before a proof
 * ever reaches the admin queue — neither media type bypasses validation. An
 * invalid result asks the customer to re-upload instead of advancing the
 * order status or creating an admin alert.
 */
export async function processPaymentProof(
  phone: string,
  mediaId: string,
  mediaType: string | null,
  customerName: string
): Promise<boolean> {
  const locale = (await getCustomerByPhone(phone))?.locale ?? DEFAULT_LOCALE;
  const messages = getMessages(locale);
  const { rows } = await db.query(
    `SELECT number, unit_price, service_price, payment_method FROM orders
     WHERE customer_phone = $1
       AND status = 'awaiting_payment_proof'
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!rows.length) return false;
  if (mediaType !== 'image' && mediaType !== 'document') return false;

  const { number, unit_price, service_price, payment_method } = rows[0];
  const amount = Number(unit_price) + Number(service_price || 0);

  const fileBase64 = await downloadWhatsAppMedia(mediaId);
  const extracted = fileBase64 ? await extractPaymentProofData(fileBase64, mediaType) : null;

  if (!extracted || extracted.valid === false) {
    logger.info(
      `[PAYMENT] Rejected proof for order ${number} from ${phone}: ${extracted?.reason || 'could not download/read file'}`
    );
    await sendWhatsAppMessage(phone, messages.payment.proofInvalid());
    return true;
  }

  logger.info(
    `[PAYMENT] Proof extracted for order ${number}: amount=${extracted.amount} date=${extracted.date} reference=${extracted.reference}`
  );

  await db.query(
    `UPDATE orders
     SET payment_proof_media_id = $2,
         payment_proof_media_type = $3,
         status = 'payment_proof_received',
         updated_at = NOW()
     WHERE number = $1`,
    [number, mediaId, mediaType]
  );

  const methodName = Object.values(getPaymentMethods(locale))
    .find(m => m.id === payment_method)?.name || payment_method;

  await sendWhatsAppMessage(phone, messages.payment.proofReceivedCustomer(customerName));

  await createAlert(
    'payment_proof',
    number,
    `Comprovativo de pagamento recebido para o pedido ${number} (${methodName}, ${formatPrice(amount)}) — cliente ${phone}.`
  );

  await notifyAdminsPaymentProofReceived(number, phone, mediaId, mediaType, amount, methodName, customerName);

  return true;
}

/**
 * Forwards the customer's just-validated payment-proof photo/PDF to every
 * admin's own WhatsApp number as an interactive message — the proof as the
 * header, order/amount/customer details as the body, and Approve/Reject
 * buttons attached directly so an admin can act from WhatsApp itself instead
 * of switching to the panel (see processAdminPaymentReply). In addition to
 * the admin_alerts row created by the caller, since the panel-only alert feed
 * means nobody gets pinged until they happen to check it. Reuses the mediaId
 * Meta already issued for the incoming proof instead of re-uploading the
 * downloaded bytes. Best-effort per admin — one failed send must not block
 * the rest or fail the payment-proof flow itself.
 */
async function notifyAdminsPaymentProofReceived(
  orderNumber: string,
  customerPhone: string,
  mediaId: string,
  mediaType: 'image' | 'document',
  amount: number,
  methodName: string,
  customerName: string
): Promise<void> {
  const body = t.admin.paymentProofReceived(orderNumber, methodName, formatPrice(amount), customerName, customerPhone);
  const admins = await getAllAdmins();

  for (const admin of admins) {
    try {
      await sendWhatsAppButtons(
        admin.phone,
        body,
        [t.admin.approvePaymentButtonLabel(), t.admin.rejectPaymentButtonLabel()],
        [`admin_approve_payment_${orderNumber}`, `admin_reject_payment_${orderNumber}`],
        { type: mediaType, id: mediaId }
      );
    } catch (error: any) {
      logger.error(`Error forwarding payment proof for order ${orderNumber} to admin ${admin.phone}: ${error.message}`);
    }
  }
}

/**
 * Handles a reply from a number in admin_users to the payment-proof-received
 * message above — the WhatsApp-native equivalent of the admin panel's
 * POST /orders/:number/review (order.controller.ts's reviewOrderHandler),
 * so either surface reaches the same approve/reject outcome. Button-only,
 * same reasoning as processAdminStockReply in product.service.ts: the order
 * number is decoded straight from the button's reply id
 * (admin_approve_payment_${orderNumber} / admin_reject_payment_${orderNumber}),
 * never from free text. Re-checks the order's current status before acting
 * so a double-tap — or the admin panel and a WhatsApp tap racing each other —
 * is a safe no-op on the second attempt, not a duplicate invoice/rejection.
 */
export async function processAdminPaymentReply(adminPhone: string, buttonReplyId: string | null): Promise<void> {
  const match = buttonReplyId?.match(/^admin_(approve|reject)_payment_(.+)$/);
  if (!match) {
    await sendWhatsAppMessage(adminPhone, t.admin.useButtonsPrompt());
    return;
  }

  const [, action, orderNumber] = match;
  logger.info(`[ADMIN PAYMENT] Admin ${adminPhone} tapped "${action}" for order ${orderNumber}`);

  const order = await getOrderByNumber(orderNumber);
  if (!order || order.status !== 'payment_proof_received') {
    logger.debug(`[ADMIN PAYMENT] Order ${orderNumber} already handled (status=${order?.status ?? 'not found'}) — telling ${adminPhone}`);
    await sendWhatsAppMessage(adminPhone, t.admin.alreadyHandled(orderNumber));
    return;
  }

  if (action === 'approve') {
    const admin = await getAdminByPhone(adminPhone);
    await approveOrder(orderNumber, admin?.id ?? 0);
    await sendWhatsAppMessage(adminPhone, t.admin.paymentApprovedAck(orderNumber));
    logger.info(`[ADMIN PAYMENT] Order ${orderNumber} approved by ${adminPhone} — invoice sent to customer`);
  } else {
    await updateOrderStatus(orderNumber, 'rejected');
    const customerMessages = await resolveMessages(order.customer_phone);
    await sendWhatsAppMessage(order.customer_phone, customerMessages.order.rejected(orderNumber));
    await sendWhatsAppMessage(adminPhone, t.admin.paymentRejectedAck(orderNumber));
    logger.info(`[ADMIN PAYMENT] Order ${orderNumber} rejected by ${adminPhone} — customer notified`);
  }
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
  const customer = await getCustomerByPhone(order.customer_phone);
  const firstName = customer?.name?.split(' ')[0] || 'Cliente';
  await sendFinalInvoiceWhatsApp(order.customer_phone, invoicePDF, orderNumber, firstName);

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
 * Alerts staff about a physical payment request (mobile POS or cash on
 * delivery) so they can arrange it: records it in the admin alerts feed, and
 * also pushes the details straight to every admin's own WhatsApp number —
 * the alerts feed alone means nobody gets pinged until they happen to check
 * the panel, and this needs a terminal taken to the customer promptly.
 * Best-effort per admin — one failed send must not block the rest.
 */
async function notifyAgentInPersonPayment(
  orderNumber: string,
  customerPhone: string,
  amount: number,
  method: any
): Promise<void> {
  await createAlert(
    'in_person_payment',
    orderNumber,
    `Pagamento presencial solicitado para o pedido ${orderNumber} (${method.name}, ${formatPrice(amount)}) — cliente ${customerPhone}.`
  );

  const customer = await getCustomerByPhone(customerPhone);
  const customerName = customer?.name?.split(' ')[0] || 'Cliente';
  const address = customer?.address || 'N/D';

  const body = t.admin.inPersonPaymentRequested(
    orderNumber,
    method.name,
    formatPrice(amount),
    customerName,
    customerPhone,
    address
  );

  const admins = await getAllAdmins();
  for (const admin of admins) {
    try {
      await sendWhatsAppMessage(admin.phone, body);
    } catch (error: any) {
      logger.error(`Error notifying admin ${admin.phone} about in-person payment for order ${orderNumber}: ${error.message}`);
    }
  }
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
