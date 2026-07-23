import * as XLSX from 'xlsx';
import fs from 'fs';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { SUBCATEGORY_TO_SERVICE_CATEGORY } from '../constants/serviceCategory.js';
import {
  searchProductsInInventory,
  addToProductWaitlist,
  findZeroQuantityProductMatch,
  getProductById,
  getMatchingServicesForProduct,
  Product
} from '../models/product.model.js';
import { Service } from '../models/service.model.js';
import {
  importProductsBatch,
  ImportItem,
  RestockNotification
} from '../models/supplier.model.js';
import {
  createOrder,
  addServiceToOrder,
  generateOrderNumber,
  updateOrderStatus,
  getOrderByNumber,
  getOrdersAwaitingCourtesyMessage,
  markCourtesyMessageSent,
  getOrdersAwaitingAdminReminder,
  markAdminReminderSent
} from '../models/order.model.js';
import { getCustomerVehicles } from '../models/vehicle.model.js';
import { getCustomerByPhone } from '../models/customer.model.js';
import { getAllAdmins } from '../models/adminUser.model.js';
import { resolveMessages, resolveLocale } from './customer.service.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from './whatsapp.service.js';
import { sendReply, sendReplyButtons, sendReplyList } from './reply.service.js';
import { generateProformaPDF, sendProformaWhatsApp } from './pdf.service.js';
import { askPaymentMethod } from './payment.service.js';
import {
  savePendingOptions,
  clearPendingOptions,
  savePendingWaitlistOffer,
  clearPendingWaitlistOffer,
  savePendingServiceOffer,
  clearPendingServiceOffer,
  savePendingStockUnavailableOffer,
  clearPendingStockUnavailableOffer,
  savePendingRestockOrderOffer,
  clearPendingRestockOrderOffer,
  getChosenVehicle,
  PendingServiceOffer,
  PendingStockUnavailableOffer
} from './session.service.js';
import { formatPrice } from '../utils/helpers.js';
import { t, getMessages } from '../i18n/messages.js';

/**
 * Determines which of a customer's vehicles a product search should be
 * scoped to — the customer's only vehicle, or their previously chosen one
 * when they have several, falling back to the first if none was chosen.
 */
async function resolveSearchVehicle(phone: string) {
  const vehicles = await getCustomerVehicles(phone);
  if (vehicles.length === 0) return null;
  if (vehicles.length === 1) return vehicles[0];

  const chosenId = await getChosenVehicle(phone);
  return vehicles.find((v) => v.id === chosenId) || vehicles[0];
}

/**
 * Runs the deterministic full-text inventory search for the customer's
 * message, then either sends a WhatsApp list of matches, offers a waitlist
 * for an out-of-stock match, or reports no results found.
 */
export async function searchAndRespond(phone: string, customerText: string, customerName: string): Promise<void> {
  const messages = await resolveMessages(phone);
  logger.info(`[PRODUCT SEARCH] ${phone} searching for: "${customerText}"`);
  await sendReply(phone, messages.agent.checkingStock());

  const vehicle = await resolveSearchVehicle(phone);
  const options = await searchProductsInInventory({ part: customerText, vehicle });

  if (!options || options.length === 0) {
    logger.info(`[PRODUCT SEARCH] ${phone} no matches for "${customerText}"`);

    const candidate = await findZeroQuantityProductMatch({ part: customerText });
    if (candidate) {
      logger.info(`[PRODUCT SEARCH] ${phone} offering waitlist for out-of-stock match: ${candidate.name}`);
      await sendReplyButtons(phone, messages.agent.noStockFound(), messages.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name, query: customerText });
    } else {
      await sendReply(phone, messages.agent.noStockFound());
    }
    return;
  }

  logger.info(`[PRODUCT SEARCH] ${phone} found ${options.length} match(es) for "${customerText}": ${options.map(o => o.name).join(', ')}`);

  await savePendingOptions(phone, options);

  const body = vehicle
    ? messages.agent.searchListBodyForVehicle(options.length, customerText, vehicle.make, vehicle.model, vehicle.year, customerName)
    : messages.agent.searchListBody(options.length, customerText, customerName);
  await sendReplyList(phone, body, messages.agent.searchListButton(), buildProductListRows(options));
}

/**
 * Truncates a string to a maximum length, appending an ellipsis when it
 * had to cut text off.
 */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Converts a list of matched products into WhatsApp List Message rows,
 * each carrying a selectable option id, truncated title, and reference/price/supplier description.
 */
function buildProductListRows(options: Product[]): { id: string; title: string; description: string }[] {
  return options.map((item, i) => ({
    id: `option_${i + 1}`,
    title: truncate(item.name, 24),
    description: truncate(
      `Ref: ${item.reference} • ${formatPrice(item.price)}${item.supplier ? ` • ${item.supplier}` : ''}`,
      72
    ),
  }));
}

/**
 * Resolves which product-search result the customer picked, from either a
 * tapped list row's option id or a typed digit, returning null if neither matches.
 */
function resolveOptionIndex(customerText: string | null, listReplyId: string | null): number | null {
  const idMatch = listReplyId?.match(/^option_(\d+)$/);
  if (idMatch) return parseInt(idMatch[1], 10) - 1;

  const digitMatch = customerText?.trim().match(/^(\d+)$/);
  if (digitMatch) return parseInt(digitMatch[1], 10) - 1;

  return null;
}

/**
 * Converts a list of matching services into WhatsApp List Message rows,
 * appending a final "skip" row so the customer can decline all of them.
 */
function buildServiceListRows(
  services: Service[],
  skipLabel: string
): { id: string; title: string; description: string }[] {
  const rows = services.map((s, i) => ({
    id: `service_option_${i + 1}`,
    title: truncate(s.service_name, 24),
    description: truncate(
      `${formatPrice(s.service_base_price)}${s.provider_name ? ` • ${s.provider_name}` : ''}`,
      72
    ),
  }));
  rows.push({ id: `service_option_${services.length + 1}`, title: truncate(skipLabel, 24), description: '' });
  return rows;
}

/**
 * Resolves the customer's reply to a service-offer list into a chosen
 * service index, an explicit 'skip', or null if the reply doesn't match anything offered.
 */
function resolveServiceSelection(
  customerText: string | null,
  listReplyId: string | null,
  serviceCount: number
): number | 'skip' | null {
  const r = customerText?.trim().toLowerCase() ?? '';
  if (r.includes('não') || r.includes('nao') || r.includes('no thanks') || r === 'no' || r.includes('❌')) return 'skip';

  const idMatch = listReplyId?.match(/^service_option_(\d+)$/);
  if (idMatch) {
    const idx = parseInt(idMatch[1], 10) - 1;
    return idx === serviceCount ? 'skip' : idx;
  }

  const digitMatch = r.match(/^(\d+)$/);
  if (digitMatch) {
    const idx = parseInt(digitMatch[1], 10) - 1;
    if (idx === serviceCount) return 'skip';
    if (idx >= 0 && idx < serviceCount) return idx;
  }

  return null;
}

/**
 * Moves an order into awaiting_stock_confirmation, tells the customer
 * stock is being checked, and notifies admins to confirm or reject availability.
 */
async function requestStockConfirmation(
  phone: string,
  orderNumber: string
): Promise<void> {
  const messages = await resolveMessages(phone);
  await updateOrderStatus(orderNumber, 'awaiting_stock_confirmation');
  await sendReply(phone, messages.agent.confirmingAvailability());
  await notifyAdminsStockConfirmationNeeded(orderNumber);
}

/**
 * Pushes a stock-confirmation request with Confirm/Unavailable buttons to
 * every admin for an order that needs its stock verified.
 */
async function notifyAdminsStockConfirmationNeeded(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) {
    logger.error(`[ADMIN STOCK] notifyAdminsStockConfirmationNeeded: order ${orderNumber} not found`);
    return;
  }

  const customer = await getCustomerByPhone(order.customer_phone);
  const customerName = customer?.name?.split(' ')[0] || 'Cliente';
  const total = Number(order.unit_price) + Number(order.service_price || 0);

  const admins = await getAllAdmins();
  logger.debug(`[ADMIN STOCK] Notifying ${admins.length} admin(s) about order ${orderNumber} (${order.product_name})`);

  for (const admin of admins) {
    try {
      await sendWhatsAppButtons(
        admin.phone,
        t.admin.stockConfirmationNeeded(
          orderNumber,
          order.product_name,
          order.reference,
          order.supplier_name,
          formatPrice(total),
          customerName,
          order.customer_phone
        ),
        [t.admin.confirmButtonLabel(), t.admin.unavailableButtonLabel()],
        [`admin_confirm_${orderNumber}`, `admin_unavailable_${orderNumber}`]
      );
      logger.info(`[ADMIN STOCK] Sent stock-confirmation request for order ${orderNumber} to admin ${admin.phone}`);
    } catch (error: any) {
      logger.error(`[ADMIN STOCK] Error notifying admin ${admin.phone} about stock confirmation for order ${orderNumber}`, error);
    }
  }
}

/**
 * Finalizes an order once staff confirm stock is available: sends the
 * customer a confirmation message, generates and sends the proforma PDF, and
 * kicks off the payment-method flow.
 */
export async function confirmStockAndFinalizeOrder(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) throw new ApiError(404, `Order ${orderNumber} not found`);

  const phone = order.customer_phone;
  const product: Product = {
    name: order.product_name,
    reference: order.reference,
    price: Number(order.unit_price),
    quantity: order.quantity,
    supplier: order.supplier_name,
  };
  const service = order.service_price
    ? { name: order.service_name, price: Number(order.service_price) }
    : null;
  const total = product.price + (service?.price ?? 0);

  const customer = await getCustomerByPhone(phone);
  const firstName = customer?.name?.split(' ')[0] || 'Cliente';
  const locale = await resolveLocale(phone);
  const messages = getMessages(locale);
  await sendReply(phone, messages.agent.stockConfirmedIntro(product.name, firstName));

  const proformaPath = await generateProformaPDF(orderNumber, phone, product, service, locale);
  await sendProformaWhatsApp(phone, proformaPath, orderNumber, locale);
  await askPaymentMethod(phone, orderNumber, total);

  setTimeout(() => {
    try {
      fs.unlinkSync(proformaPath);
    } catch {
      // no-op
    }
  }, 60000);
}

/**
 * Marks an order's stock as unavailable and offers the customer a choice
 * between an alternative product search or joining the waitlist.
 */
export async function markStockUnavailableAndOfferAlternative(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) throw new ApiError(404, `Order ${orderNumber} not found`);

  await updateOrderStatus(orderNumber, 'stock_unavailable');

  const phone = order.customer_phone;
  const messages = await resolveMessages(phone);
  await sendReplyButtons(phone, messages.agent.stockUnavailable(order.product_name, order.reference), messages.agent.stockUnavailableButtons);
  await savePendingStockUnavailableOffer(phone, {
    orderNumber,
    productId: order.product_id,
    productName: order.product_name,
  });
}

const GENERIC_YES_PATTERN = /\b(sim|yes|yeah|yep|yup|sure|ok(ay)?|certo|pode|podes|quero|aceito|est[áa]\s*bem)\b/i;
const GENERIC_NO_PATTERN = /\b(n[ãa]o|no|nope|not\s*(interested|now)|dispensa)\b/i;

/**
 * Checks whether a customer's reply reads as a "yes" — a button tap, a
 * generic affirmative word, or an optional prompt-specific extra pattern.
 */
function isAffirmativeReply(reply: string, extra?: RegExp): boolean {
  const r = reply.toLowerCase().trim();
  if (r === '1' || r.includes('✅') || r.includes('btn_0')) return true;
  if (GENERIC_YES_PATTERN.test(r)) return true;
  return extra ? extra.test(r) : false;
}

/**
 * Checks whether a customer's reply reads as a "no" — a button tap, a
 * generic negative word, or an optional prompt-specific extra pattern.
 */
function isNegativeReply(reply: string, extra?: RegExp): boolean {
  const r = reply.toLowerCase().trim();
  if (r === '2' || r.includes('❌') || r.includes('btn_1')) return true;
  if (GENERIC_NO_PATTERN.test(r)) return true;
  return extra ? extra.test(r) : false;
}

const STOCK_UNAVAILABLE_YES_EXTRA = /\b(alternative|alternativa|other\s*option|outra\s*op[çc][ãa]o)\b/i;
const STOCK_UNAVAILABLE_NO_EXTRA = /\b(wait\s*list|waitlist|join\s*(the\s*)?waitlist|lista\s*de\s*espera)\b/i;

/**
 * Handles the customer's reply to the "stock unavailable" offer: on yes,
 * searches for an alternative product (or falls back to the waitlist); on
 * no, adds them to the waitlist; otherwise leaves the offer pending.
 */
export async function processStockUnavailableChoice(
  phone: string,
  reply: string,
  offer: PendingStockUnavailableOffer,
  customerName: string
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const isYes = isAffirmativeReply(reply, STOCK_UNAVAILABLE_YES_EXTRA);
  const isNo = isNegativeReply(reply, STOCK_UNAVAILABLE_NO_EXTRA);

  if (isYes) {
    await clearPendingStockUnavailableOffer(phone);
    const vehicle = await resolveSearchVehicle(phone);
    const options = await searchProductsInInventory({ part: offer.productName, vehicle, excludeProductId: offer.productId });
    if (!options.length) {
      await sendReplyButtons(phone, messages.agent.noStockFound(), messages.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: offer.productId, productName: offer.productName });
      return true;
    }
    await savePendingOptions(phone, options);
    await sendReplyList(
      phone,
      messages.agent.searchListBody(options.length, offer.productName, customerName),
      messages.agent.searchListButton(),
      buildProductListRows(options)
    );
    return true;
  }
  if (isNo) {
    await clearPendingStockUnavailableOffer(phone);
    await addToProductWaitlist(offer.productId, phone);
    await sendReply(phone, messages.agent.waitlistConfirmed(offer.productName));
    return true;
  }
  return false;
}

/**
 * Handles an admin's tap on the Confirm/Unavailable stock buttons sent
 * over WhatsApp, finalizing or marking-unavailable the matching order and
 * telling the admin if it was already handled.
 */
export async function processAdminStockReply(adminPhone: string, buttonReplyId: string | null): Promise<void> {
  logger.debug(`[ADMIN STOCK] Reply from admin ${adminPhone}: buttonReplyId=${buttonReplyId}`);

  const match = buttonReplyId?.match(/^admin_(confirm|unavailable)_(.+)$/);
  if (!match) {
    logger.debug(`[ADMIN STOCK] Reply from ${adminPhone} did not match a stock-confirmation button (buttonReplyId=${buttonReplyId}) — sending nudge`);
    await sendWhatsAppMessage(adminPhone, t.admin.useButtonsPrompt());
    return;
  }

  const [, action, orderNumber] = match;
  logger.info(`[ADMIN STOCK] Admin ${adminPhone} tapped "${action}" for order ${orderNumber}`);

  const order = await getOrderByNumber(orderNumber);
  if (!order || order.status !== 'awaiting_stock_confirmation') {
    logger.debug(`[ADMIN STOCK] Order ${orderNumber} already handled (status=${order?.status ?? 'not found'}) — telling ${adminPhone}`);
    await sendWhatsAppMessage(adminPhone, t.admin.alreadyHandled(orderNumber));
    return;
  }

  if (action === 'confirm') {
    await confirmStockAndFinalizeOrder(orderNumber);
    await sendWhatsAppMessage(adminPhone, t.admin.confirmedAck(orderNumber));
    logger.info(`[ADMIN STOCK] Order ${orderNumber} confirmed by ${adminPhone} — proforma sent to customer`);
  } else {
    await markStockUnavailableAndOfferAlternative(orderNumber);
    await sendWhatsAppMessage(adminPhone, t.admin.unavailableAck(orderNumber));
    logger.info(`[ADMIN STOCK] Order ${orderNumber} marked unavailable by ${adminPhone} — customer notified`);
  }
}

/**
 * Sweeps orders overdue by 20+ minutes awaiting stock confirmation and
 * sends each customer a courtesy "still checking" message.
 */
export async function sendStockConfirmationCourtesyMessages(): Promise<void> {
  const overdue = await getOrdersAwaitingCourtesyMessage(20);
  for (const order of overdue) {
    try {
      const messages = await resolveMessages(order.customer_phone);
      await sendReply(order.customer_phone, messages.agent.stockConfirmationCourtesy());
      await markCourtesyMessageSent(order.number);
    } catch (error: any) {
      logger.error(`Error sending stock-confirmation courtesy message for order ${order.number}`, error);
    }
  }
}

/**
 * Sweeps orders overdue by 15+ minutes awaiting stock confirmation and
 * re-pushes the Confirm/Unavailable buttons to all admins as a reminder.
 */
export async function sendStockConfirmationAdminReminders(): Promise<void> {
  const overdue = await getOrdersAwaitingAdminReminder(15);
  if (overdue.length) {
    logger.debug(`[ADMIN STOCK] Admin reminder sweep: ${overdue.length} order(s) overdue past 15 minutes`);
  }
  for (const order of overdue) {
    try {
      const admins = await getAllAdmins();
      for (const admin of admins) {
        await sendWhatsAppButtons(
          admin.phone,
          t.admin.reminderBody(order.customer_first_name, order.product_name, order.number),
          [t.admin.confirmButtonLabel(), t.admin.unavailableButtonLabel()],
          [`admin_confirm_${order.number}`, `admin_unavailable_${order.number}`]
        );
      }
      await markAdminReminderSent(order.number);
      logger.info(`[ADMIN STOCK] Sent 15-min reminder for order ${order.number} to ${admins.length} admin(s)`);
    } catch (error: any) {
      logger.error(`[ADMIN STOCK] Error sending stock-confirmation admin reminder for order ${order.number}`, error);
    }
  }
}

/**
 * Creates a new order for a chosen product and either offers the customer
 * matching add-on services first, or goes straight to requesting stock confirmation.
 */
async function startOrderForProduct(phone: string, product: Product): Promise<void> {
  const messages = await resolveMessages(phone);
  const orderNumber = await generateOrderNumber();
  await createOrder(orderNumber, phone, product);

  const matchingServices = product.id ? await getMatchingServicesForProduct(product.id) : [];
  const offeredServices = matchingServices.slice(0, 3);

  if (offeredServices.length > 0) {
    await sendReply(phone, messages.agent.productSelected(product.name, formatPrice(product.price)));
    await savePendingServiceOffer(phone, { orderNumber, product, services: offeredServices });
    await sendReplyList(
      phone,
      messages.agent.serviceListBody(offeredServices.length),
      messages.agent.serviceListButton(),
      buildServiceListRows(offeredServices, messages.agent.serviceSkipOption())
    );
    return;
  }

  await requestStockConfirmation(phone, orderNumber);
}

/**
 * Handles the customer's reply to a product search-results list, starting
 * an order for the chosen product or reporting the option wasn't found.
 */
export async function processProductSelection(
  phone: string,
  customerText: string | null,
  listReplyId: string | null,
  pendingOptions: Product[]
): Promise<boolean> {
  const idx = resolveOptionIndex(customerText, listReplyId);
  if (idx === null) return false;

  const choice = pendingOptions[idx];
  if (!choice) {
    const messages = await resolveMessages(phone);
    await sendReply(phone, messages.agent.optionNotFound());
    return true;
  }

  await clearPendingOptions(phone);

  await startOrderForProduct(phone, choice);
  return true;
}

/**
 * Handles the customer's reply to a service-offer list, adding the chosen
 * service to the order (or skipping) and then requesting stock confirmation.
 */
export async function processServiceSelection(
  phone: string,
  customerText: string | null,
  listReplyId: string | null,
  offer: PendingServiceOffer
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const selection = resolveServiceSelection(customerText, listReplyId, offer.services.length);
  if (selection === null) return false;

  await clearPendingServiceOffer(phone);

  if (selection === 'skip') {
    await sendReply(phone, messages.agent.serviceDeclined());
    await requestStockConfirmation(phone, offer.orderNumber);
    return true;
  }

  const chosen = offer.services[selection];
  await addServiceToOrder(offer.orderNumber, chosen.service_name, chosen.service_base_price);
  const total = Number(offer.product.price) + Number(chosen.service_base_price);
  await sendReply(phone, messages.agent.serviceAdded(chosen.service_name, formatPrice(total)));
  await requestStockConfirmation(phone, offer.orderNumber);
  return true;
}

const WAITLIST_YES_EXTRA = /\b(add\s*me|notify\s*me|wait\s*list|waitlist|join\s*(the\s*)?waitlist|avisa[- ]?me|lista\s*de\s*espera)\b/i;

/**
 * Handles the customer's reply to a "join the waitlist?" offer for an
 * out-of-stock product, opting them in or acknowledging their decline.
 */
export async function processWaitlistOptIn(
  phone: string,
  reply: string,
  offer: { productId: number; productName: string; query?: string }
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const isYes = isAffirmativeReply(reply, WAITLIST_YES_EXTRA);
  const isNo = isNegativeReply(reply);

  if (isYes) {
    await addToProductWaitlist(offer.productId, phone);
    await clearPendingWaitlistOffer(phone);
    await sendReply(phone, messages.agent.waitlistConfirmed(offer.query ?? offer.productName));
    return true;
  }
  if (isNo) {
    await clearPendingWaitlistOffer(phone);
    await sendReply(phone, messages.agent.waitlistDeclined());
    return true;
  }
  return false;
}

/**
 * After an inventory import restocks products, sends each waitlisted
 * customer a restock notification with order/decline buttons, in their own locale.
 */
export async function notifyWaitlistedCustomers(restockNotifications: RestockNotification[]): Promise<void> {
  for (const { productId, productName, phones } of restockNotifications) {
    const product = await getProductById(productId);
    if (!product) continue;

    for (const phone of phones) {
      try {
        const customer = await getCustomerByPhone(phone);
        const firstName = customer?.name?.split(' ')[0] || 'Cliente';
        const messages = getMessages(await resolveLocale(phone));

        const vehicles = await getCustomerVehicles(phone);
        const vehicleSummary = vehicles.length ? `${vehicles[0].make} ${vehicles[0].model} ${vehicles[0].year}` : null;

        await sendReplyButtons(
          phone,
          messages.agent.restockNotification(firstName, productName, vehicleSummary, formatPrice(product.price), product.supplier || ''),
          messages.agent.restockNotificationButtons
        );
        await savePendingRestockOrderOffer(phone, { productId, productName });
      } catch (error: any) {
        logger.error(`Error sending restock notification to ${phone} for product ${productName}`, error);
      }
    }
  }
}

const RESTOCK_YES_EXTRA = /\b(order\s*now|order\s*it|pedir\s*agora|quero\s*encomendar|comprar)\b/i;
const RESTOCK_NO_EXTRA = /\b(not\s*now|maybe\s*later|agora\s*n[ãa]o)\b/i;

/**
 * Handles the customer's reply to a restock notification: on yes, starts
 * an order for the product (or falls back to the waitlist if it's out of
 * stock again); on no, acknowledges the decline.
 */
export async function processRestockOrderChoice(
  phone: string,
  reply: string,
  offer: { productId: number; productName: string }
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const isYes = isAffirmativeReply(reply, RESTOCK_YES_EXTRA);
  const isNo = isNegativeReply(reply, RESTOCK_NO_EXTRA);

  if (isYes) {
    await clearPendingRestockOrderOffer(phone);
    const product = await getProductById(offer.productId);
    if (!product || product.quantity <= 0) {
      await addToProductWaitlist(offer.productId, phone);
      await sendReply(phone, messages.agent.waitlistConfirmed(offer.productName));
      return true;
    }
    await startOrderForProduct(phone, product);
    return true;
  }
  if (isNo) {
    await clearPendingRestockOrderOffer(phone);
    await sendReply(phone, messages.agent.waitlistDeclined());
    return true;
  }
  return false;
}

export interface InventoryImportResult {
  inserted: number;
  updated: number;
  restockNotifications: RestockNotification[];
  skipped?: { row: number; reasons: string[] }[];
}

/**
 * Imports a batch of parsed inventory items into the DB and notifies any
 * waitlisted customers whose products were restocked as a result.
 */
export async function importInventoryBatch(
  items: ImportItem[],
  defaultSupplierId: number | null
): Promise<InventoryImportResult> {
  const result = await importProductsBatch(items, defaultSupplierId);
  await notifyWaitlistedCustomers(result.restockNotifications);
  return result;
}

const HEADER_ALIASES: Record<string, string[]> = {
  reference: ['sku', 'reference', 'referencia', 'ref'],
  name: ['product', 'produto', 'name', 'nome'],
  price: ['price', 'preco', 'preço'],
  quantity: ['quantity', 'quantidade', 'qty', 'stock'],
  supplierName: ['supplier name', 'supplier', 'supplier_name', 'fornecedor', 'nome_fornecedor'],
  supplierAddress: ['supplier address', 'supplier_address', 'endereco_fornecedor', 'supplier_province', 'provincia_fornecedor'],
  supplierPhone: ['supplier phone', 'supplier_phone', 'telefone_fornecedor'],
  category: ['category', 'categoria'],
  subcategory: ['subcategory', 'subcategoria'],
  vehicleMake: ['vehicle_make', 'vehicle make', 'marca_veiculo'],
  vehicleModel: ['vehicle_model', 'vehicle model', 'modelo_veiculo'],
  yearStart: ['year_start', 'year start', 'ano_inicio'],
  yearEnd: ['year_end', 'year end', 'ano_fim'],
  engine: ['engine', 'motor'],
  deliveryTime: ['delivery_time', 'delivery time', 'prazo_entrega'],
  brand: ['part_brand', 'brand', 'marca'],
  oemReference: ['oem_reference', 'oem reference', 'referencia_oem'],
  engineNumber: ['engine_number', 'engine number', 'numero_motor'],
  viscosity: ['viscosity', 'viscosidade'],
  engineType: ['engine_type', 'engine type', 'tipo_motor'],
  volumeLiters: ['volume_liters', 'volume liters', 'volume_litros'],
  specification: ['specification', 'especificacao'],
  intervalKm: ['interval_km', 'interval km', 'intervalo_km'],
  imageUrl: ['image_url', 'image url', 'url_imagem'],
  synonyms: ['synonyms', 'sinonimos'],
  description: ['description', 'descricao', 'descrição'],
};

const REQUIRED_COLUMNS: { field: keyof typeof HEADER_ALIASES; label: string }[] = [
  { field: 'reference', label: 'SKU' },
  { field: 'name', label: 'Product' },
  { field: 'price', label: 'Price' },
  { field: 'quantity', label: 'Quantity' },
  { field: 'supplierName', label: 'Supplier Name' },
  { field: 'category', label: 'Category' },
  { field: 'subcategory', label: 'Subcategory' },
  { field: 'vehicleMake', label: 'Vehicle Make' },
  { field: 'deliveryTime', label: 'Delivery Time' },
  { field: 'synonyms', label: 'Synonyms' },
  { field: 'description', label: 'Description' },
];

/**
 * Checks an uploaded spreadsheet's header row against the required
 * inventory columns (accepting any known alias) and returns the labels of any that are missing.
 */
function getMissingRequiredColumns(headerRow: unknown[]): string[] {
  const headerSet = new Set(headerRow.map((h) => String(h ?? '').trim().toLowerCase()));
  return REQUIRED_COLUMNS.filter(({ field }) => !HEADER_ALIASES[field].some((alias) => headerSet.has(alias))).map(
    ({ label }) => label
  );
}

/**
 * Validates and normalizes a single spreadsheet row into an ImportItem,
 * resolving header aliases and the subcategory's service-category mapping,
 * or returns the list of validation failure reasons if the row is invalid.
 */
function validateRow(row: Record<string, any>, rowNumber: number): { item: ImportItem } | { reasons: string[] } {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') return lowerRow[alias];
    }
    return undefined;
  };
  const pickStr = (field: string) => {
    const v = pick(field);
    return v !== undefined ? String(v) : undefined;
  };
  const pickNum = (field: string) => {
    const v = pick(field);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  };
  const pickInt = (field: string) => {
    const n = pickNum(field);
    return n !== undefined && Number.isInteger(n) ? n : undefined;
  };

  const reasons: string[] = [];

  const reference = pick('reference');
  if (!reference) reasons.push('Reference is required.');

  const name = pick('name');
  if (!name) reasons.push('Name is required.');

  const priceRaw = pick('price');
  const price = Number(priceRaw);
  if (priceRaw === undefined || Number.isNaN(price) || price < 0) {
    reasons.push('Price is required and must be a non-negative number.');
  }

  const quantityRaw = pick('quantity');
  const quantity = Number(quantityRaw);
  if (quantityRaw === undefined || !Number.isInteger(quantity) || quantity < 0) {
    reasons.push('Quantity is required and must be a non-negative whole number.');
  }

  const supplierName = pick('supplierName');
  if (!supplierName) reasons.push('Supplier is required.');

  const category = pick('category');
  if (!category) reasons.push('Category is required.');

  const subcategory = pick('subcategory');
  const serviceCategory = subcategory ? SUBCATEGORY_TO_SERVICE_CATEGORY[String(subcategory)] : undefined;
  if (!subcategory) reasons.push('Subcategory is required.');
  else if (!serviceCategory) reasons.push(`Unknown subcategory "${subcategory}" — no service_category mapping exists for it.`);

  const vehicleMake = pick('vehicleMake');
  if (!vehicleMake) reasons.push('Vehicle Make is required.');

  const deliveryTime = pick('deliveryTime');
  if (!deliveryTime) reasons.push('Delivery Time is required.');

  const synonyms = pick('synonyms');
  if (!synonyms) reasons.push('Synonyms is required.');

  const description = pick('description');
  if (!description) reasons.push('Description is required.');

  if (reasons.length) return { reasons: reasons.map((r) => `Row ${rowNumber}: ${r}`) };

  return {
    item: {
      reference: String(reference),
      name: String(name),
      price,
      quantity,
      supplierName: String(supplierName),
      supplierAddress: pickStr('supplierAddress'),
      supplierPhone: pickStr('supplierPhone'),
      category: String(category),
      subcategory: String(subcategory),
      serviceCategory: serviceCategory!,
      vehicleMake: String(vehicleMake),
      vehicleModel: pickStr('vehicleModel'),
      yearStart: pickInt('yearStart'),
      yearEnd: pickInt('yearEnd'),
      engine: pickStr('engine'),
      deliveryTime: String(deliveryTime),
      brand: pickStr('brand'),
      oemReference: pickStr('oemReference'),
      engineNumber: pickStr('engineNumber'),
      viscosity: pickStr('viscosity'),
      engineType: pickStr('engineType'),
      volumeLiters: pickNum('volumeLiters'),
      specification: pickStr('specification'),
      intervalKm: pickInt('intervalKm'),
      imageUrl: pickStr('imageUrl'),
      synonyms: String(synonyms),
      description: String(description),
    },
  };
}

/**
 * Parses an uploaded Excel inventory file, validates its header and every
 * data row, then imports the valid rows and returns the import result
 * alongside any rows that had to be skipped.
 */
export async function importInventoryFromFile(fileBuffer: Buffer): Promise<InventoryImportResult> {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const headerRow = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })[0] as unknown[] | undefined) ?? [];
  const missingColumns = getMissingRequiredColumns(headerRow);
  if (missingColumns.length) {
    throw new ApiError(400, `Missing required column(s): ${missingColumns.join(', ')}.`);
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);
  if (!rawRows.length) {
    throw new ApiError(400, 'The file has no data rows.');
  }

  const items: ImportItem[] = [];
  const skipped: { row: number; reasons: string[] }[] = [];
  rawRows.forEach((row, i) => {
    const rowNumber = i + 2;
    const result = validateRow(row, rowNumber);
    if ('reasons' in result) skipped.push({ row: rowNumber, reasons: result.reasons });
    else items.push(result.item);
  });

  const result = await importInventoryBatch(items, null);
  return { ...result, skipped };
}

const TEMPLATE_HEADER_ROW = [
  'SKU',
  'Product',
  'Price',
  'Quantity',
  'Supplier Name',
  'Supplier Address',
  'Supplier Phone',
  'Category',
  'Subcategory',
  'Vehicle Make',
  'Vehicle Model',
  'Year Start',
  'Year End',
  'Engine',
  'Delivery Time',
  'Brand',
  'OEM Reference',
  'Engine Number',
  'Viscosity',
  'Engine Type',
  'Volume Liters',
  'Specification',
  'Interval Km',
  'Image Url',
  'Synonyms',
  'Description',
];

/**
 * Generates a blank Excel workbook containing only the expected inventory
 * import header row, for staff to download as a starting template.
 */
export function generateInventoryTemplateFile(): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADER_ROW]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
