import { db } from '../config/db.js';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from './whatsapp.service.js';
import { generatePrimaveraInvoice, sendFinalInvoiceWhatsApp } from './pdf.service.js';
import { getOrderByNumber } from '../models/inventory.model.js';
import { formatPrice } from '../utils/helpers.js';

// Display names and instruction texts are Portuguese (customer-facing);
// ids are English because they are persisted in orders.payment_method.
export const PAYMENT_METHODS = {
  BANK_TRANSFER: {
    id: 'bank_transfer',
    name: 'Transferência Bancária',
    emoji: '🏦',
    instructions: (orderNumber: string, amount: number) =>
      `🏦 *Transferência Bancária*\n\n` +
      `Banco: BFA / BAI / BIC (à tua escolha)\n` +
      `IBAN: AO06 0040 0000 XXXX XXXX XXXX X\n` +
      `Titular: Rede Peças, Lda\n` +
      `Valor: *${formatPrice(amount)}*\n` +
      `Referência: *${orderNumber}* _(obrigatório)_\n\n` +
      `Após a transferência, envia aqui o comprovativo (foto ou PDF). 📸`,
    requiresProof: true,
  },

  BANK_DEPOSIT: {
    id: 'bank_deposit',
    name: 'Depósito Bancário',
    emoji: '🏧',
    instructions: (orderNumber: string, amount: number) =>
      `🏧 *Depósito Bancário*\n\n` +
      `Banco: BFA / BAI / BIC (à tua escolha)\n` +
      `Nº Conta: 000000000000\n` +
      `Titular: Rede Peças, Lda\n` +
      `Valor: *${formatPrice(amount)}*\n` +
      `Referência: *${orderNumber}* _(escreve no talão)_\n\n` +
      `Após o depósito, envia aqui a foto do talão. 📸`,
    requiresProof: true,
  },

  MULTICAIXA_EXPRESS: {
    id: 'multicaixa_express',
    name: 'Multicaixa Express',
    emoji: '📱',
    instructions: (orderNumber: string, amount: number) =>
      `📱 *Multicaixa Express*\n\n` +
      `Número: *+244 900 000 000*\n` +
      `Valor: *${formatPrice(amount)}*\n` +
      `Referência: *${orderNumber}* _(coloca na descrição)_\n\n` +
      `Após o pagamento, envia aqui o screenshot da confirmação. 📸`,
    requiresProof: true,
  },

  MOBILE_POS: {
    id: 'mobile_pos',
    name: 'TPA Móvel (Terminal de Pagamento)',
    emoji: '💳',
    instructions: (orderNumber: string, amount: number) =>
      `💳 *TPA Móvel*\n\n` +
      `Um agente da Rede Peças irá até ti com o terminal de pagamento.\n\n` +
      `Valor a pagar: *${formatPrice(amount)}*\n` +
      `Pedido: *${orderNumber}*\n\n` +
      `A nossa equipa entrará em contacto para combinar a visita. 🚗`,
    requiresProof: false,
  },

  CASH: {
    id: 'cash',
    name: 'Dinheiro em Mão',
    emoji: '💵',
    instructions: (orderNumber: string, amount: number) =>
      `💵 *Pagamento em Dinheiro*\n\n` +
      `Um agente da Rede Peças irá recolher o pagamento na entrega.\n\n` +
      `Valor a preparar: *${formatPrice(amount)}*\n` +
      `Pedido: *${orderNumber}*\n\n` +
      `Por favor tenha o valor exacto disponível. 🙏`,
    requiresProof: false,
  },
};

/**
 * Initiates the payment selection process via WhatsApp buttons.
 */
export async function askPaymentMethod(phone: string, orderNumber: string, amount: number): Promise<void> {
  const message =
    `💰 *Como preferes pagar?*\n\n` +
    `Pedido: *${orderNumber}*\n` +
    `Valor: *${formatPrice(amount)}*\n\n` +
    `Escolhe uma opção:`;

  await sendWhatsAppButtons(
    phone,
    message,
    [
      '🏦 Transferência / Depósito',
      '📱 Multicaixa Express',
      '💳 TPA Móvel / Dinheiro',
    ]
  );

  await db.query(
    `UPDATE orders SET status = 'awaiting_payment_method' WHERE number = $1`,
    [orderNumber]
  );
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
    await sendWhatsAppButtons(
      phone,
      'Preferes transferência ou depósito bancário?',
      ['🏦 Transferência', '🏧 Depósito']
    );
    await db.query(
      `UPDATE orders SET status = 'awaiting_bank_subtype' WHERE number = $1`,
      [number]
    );
    return true;
  } else if (reply.includes('multicaixa') || reply.includes('express') || reply === '2') {
    await confirmMethodAndSendInstructions(phone, number, unit_price, PAYMENT_METHODS.MULTICAIXA_EXPRESS);
    return true;
  } else if (reply.includes('tpa') || reply.includes('terminal') || reply.includes('dinheiro') || reply === '3') {
    await sendWhatsAppButtons(
      phone,
      'Preferes pagar com cartão no terminal ou em dinheiro na entrega?',
      ['💳 TPA (cartão)', '💵 Dinheiro na entrega']
    );
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

  await db.query(
    `INSERT INTO payment_proofs (order_number, media_id, media_type, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (order_number) DO UPDATE SET media_id = $2, media_type = $3`,
    [number, mediaId, mediaType]
  );

  await db.query(
    `UPDATE orders SET status = 'payment_proof_received' WHERE number = $1`,
    [number]
  );

  const methodName = Object.values(PAYMENT_METHODS)
    .find(m => m.id === payment_method)?.name || payment_method;

  await sendWhatsAppMessage(
    phone,
    `✅ *Comprovativo recebido!*\n\n` +
    `Método: ${methodName}\n` +
    `Pedido: *${number}*\n\n` +
    `A nossa equipa irá verificar o pagamento e emitir a factura em breve.\n` +
    `Normalmente demora menos de 30 minutos em horário de expediente. 🙏`
  );

  const staffPhone = config.admin.staffPhone;
  if (staffPhone) {
    await sendWhatsAppMessage(
      staffPhone,
      `📸 *COMPROVATIVO RECEBIDO*\n\n` +
      `Pedido: *${number}*\n` +
      `Método: ${methodName}\n` +
      `Valor: *${formatPrice(unit_price)}*\n` +
      `Cliente: ${phone}\n\n` +
      `Acede ao painel para verificar e aprovar:\n` +
      `🔗 ${config.appUrl}/admin/orders`
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
    `${method.emoji} *PAGAMENTO PRESENCIAL SOLICITADO*\n\n` +
    `Método: *${method.name}*\n` +
    `Pedido: *${orderNumber}*\n` +
    `Valor: *${formatPrice(amount)}*\n` +
    `Cliente: ${customerPhone}\n\n` +
    `${method.id === 'mobile_pos'
      ? 'Leva o terminal TPA ao cliente para efectuar o pagamento.'
      : 'O cliente vai pagar em dinheiro na entrega.'
    }\n\n` +
    `Após confirmação, aprova no painel:\n` +
    `🔗 ${config.appUrl}/admin/orders`
  );
}

/**
 * Dispatches a delivery checklist alert to the supplier.
 */
async function notifySupplierDelivery(order: any): Promise<void> {
  const { rows } = await db.query(
    'SELECT phone FROM suppliers WHERE id = $1',
    [order.supplier_id]
  );
  if (!rows.length || !rows[0].phone) return;

  try {
    await sendWhatsAppMessage(
      rows[0].phone,
      `📦 *NOVO PEDIDO CONFIRMADO — REDE PEÇAS*\n\n` +
      `Por favor prepare o seguinte artigo para entrega:\n\n` +
      `🔧 Peça: *${order.part_name}*\n` +
      `📋 Referência: ${order.reference}\n` +
      `🔢 Quantidade: ${order.quantity}\n` +
      `📋 Nº Pedido: *${order.number}*\n\n` +
      `A equipa da Rede Peças entrará em contacto para coordenar a recolha.\n` +
      `Obrigado pela parceria! 🙏`
    );
  } catch (error: any) {
    // Delivery notification must not fail the approval flow
    logger.error(`Error notifying supplier for delivery: ${error.message}`);
  }
}
