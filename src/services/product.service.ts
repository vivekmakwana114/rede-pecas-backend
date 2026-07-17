import * as XLSX from 'xlsx';
import fs from 'fs';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import {
  searchProductsInInventory,
  addToProductWaitlist,
  findZeroQuantityProductMatch,
  getProductById,
  Product
} from '../models/product.model.js';
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
import { sendWhatsAppMessage, sendWhatsAppList, sendWhatsAppButtons } from './whatsapp.service.js';
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
 * A customer can have several confirmed vehicles. With one, it's unambiguous; with
 * several, whichever they picked via the "which vehicle is this for?" prompt
 * (sessionService.getChosenVehicle) is used to label the results, falling back to
 * the most recently added if that's somehow unset (e.g. it expired mid-conversation).
 */
async function resolveSearchVehicle(phone: string) {
  const vehicles = await getCustomerVehicles(phone);
  if (vehicles.length === 0) return null;
  if (vehicles.length === 1) return vehicles[0];

  const chosenId = await getChosenVehicle(phone);
  return vehicles.find((v) => v.id === chosenId) || vehicles[0];
}

/**
 * Searches inventory for the customer's raw message (deterministic full-text
 * match against name/brand/reference/synonyms — no AI involved) and either
 * sends a tappable list of the up-to-3 cheapest matches, or — on no stock —
 * offers to waitlist the customer against the closest out-of-stock match.
 */
export async function searchAndRespond(phone: string, customerText: string, customerName: string): Promise<void> {
  const messages = await resolveMessages(phone);
  logger.info(`[PRODUCT SEARCH] ${phone} searching for: "${customerText}"`);
  await sendWhatsAppMessage(phone, messages.agent.checkingStock());

  const options = await searchProductsInInventory({ part: customerText });

  if (!options || options.length === 0) {
    logger.info(`[PRODUCT SEARCH] ${phone} no matches for "${customerText}"`);

    const candidate = await findZeroQuantityProductMatch({ part: customerText });
    if (candidate) {
      // Only attach the "want to be notified?" buttons when there's an actual
      // out-of-stock product to attach them to — tapping "yes" with nothing to
      // wait on would be a dead end.
      logger.info(`[PRODUCT SEARCH] ${phone} offering waitlist for out-of-stock match: ${candidate.name}`);
      await sendWhatsAppButtons(phone, messages.agent.noStockFound(), messages.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name });
    } else {
      await sendWhatsAppMessage(phone, messages.agent.noStockFound());
    }
    return;
  }

  logger.info(`[PRODUCT SEARCH] ${phone} found ${options.length} match(es) for "${customerText}": ${options.map(o => o.name).join(', ')}`);

  // Persist results so the customer's list tap / typed digit in the next message can resolve them
  await savePendingOptions(phone, options);

  const vehicle = await resolveSearchVehicle(phone);
  const body = vehicle
    ? messages.agent.searchListBodyForVehicle(options.length, customerText, vehicle.make, vehicle.model, vehicle.year, customerName)
    : messages.agent.searchListBody(options.length, customerText, customerName);
  await sendWhatsAppList(phone, body, messages.agent.searchListButton(), buildProductListRows(options));
}

// WhatsApp caps list row title at 24 chars and description at 72 — truncate
// rather than let the whole message get rejected by the API.
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function buildProductListRows(options: Product[]): { id: string; title: string; description: string }[] {
  return options.map((item, i) => ({
    id: `option_${i + 1}`,
    title: truncate(item.name, 24),
    description: truncate(
      `Ref: ${item.reference} • ${formatPrice(item.price)} • ${item.delivery_time}${item.supplier ? ` • ${item.supplier}` : ''}`,
      72
    ),
  }));
}

/**
 * Resolves a reply against a just-shown product list to a 0-based index —
 * either the tapped row's id ("option_2") or a typed digit ("2"). Returns
 * null when the reply isn't shaped like a selection at all, so the caller
 * can fall back to treating it as a brand-new search instead of a dead end.
 */
function resolveOptionIndex(customerText: string | null, listReplyId: string | null): number | null {
  const idMatch = listReplyId?.match(/^option_(\d+)$/);
  if (idMatch) return parseInt(idMatch[1], 10) - 1;

  const digitMatch = customerText?.trim().match(/^(\d+)$/);
  if (digitMatch) return parseInt(digitMatch[1], 10) - 1;

  return null;
}

/**
 * Marks the order's contents as final (product, plus an optional accepted
 * service line) and hands it off to the admin for stock-with-supplier
 * confirmation — no proforma or payment prompt yet, that only happens once
 * the admin confirms (see confirmStockAndFinalizeOrder). Shared by the
 * no-service path in processProductSelection and both branches of
 * processServiceOptIn below, so the admin only ever sees a fully-decided
 * order — never one still mid service-question.
 */
async function requestStockConfirmation(
  phone: string,
  orderNumber: string
): Promise<void> {
  const messages = await resolveMessages(phone);
  await updateOrderStatus(orderNumber, 'awaiting_stock_confirmation');
  await sendWhatsAppMessage(phone, messages.agent.confirmingAvailability());
  await notifyAdminsStockConfirmationNeeded(orderNumber);
}

/**
 * Pushes the order details to every admin (admin_users, not just one hardcoded
 * number) with two buttons whose reply ids encode the order number directly
 * (admin_confirm_${orderNumber} / admin_unavailable_${orderNumber}) — see
 * processAdminStockReply below for why: it lets a tap resolve unambiguously
 * to the right order without any session-state "pending order" tracking, even
 * if the admin has several of these outstanding at once.
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
 * Generates and sends the proforma for an order the admin just confirmed is
 * in stock, then kicks off the payment-method flow with the combined total.
 * Runs from an admin-panel HTTP request (see order.controller.ts) that can
 * happen minutes later in a completely different request lifecycle, so it
 * rebuilds the product/service shape straight from the order row (already
 * carries product_name, reference, unit_price, supplier_name, service_name,
 * service_price via getOrderByNumber's join) rather than depending on any
 * in-memory object or Redis session state from the original conversation.
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
    delivery_time: '',
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
  await sendWhatsAppMessage(phone, messages.agent.stockConfirmedIntro(product.name, firstName));

  const proformaPath = await generateProformaPDF(orderNumber, phone, product, service, locale);
  await sendProformaWhatsApp(phone, proformaPath, orderNumber, locale);
  await askPaymentMethod(phone, orderNumber, total);

  // Clean temp PDF asynchronously
  setTimeout(() => {
    try {
      fs.unlinkSync(proformaPath);
    } catch {
      // best-effort cleanup, ignore if already removed
    }
  }, 60000);
}

/**
 * The admin declined stock availability — no payment was ever taken, so
 * there's nothing to roll back. Notifies the customer and offers a fresh
 * search for alternatives or the waitlist, same pattern as the no-stock-found
 * waitlist offer in searchAndRespond.
 */
export async function markStockUnavailableAndOfferAlternative(orderNumber: string): Promise<void> {
  const order = await getOrderByNumber(orderNumber);
  if (!order) throw new ApiError(404, `Order ${orderNumber} not found`);

  await updateOrderStatus(orderNumber, 'stock_unavailable');

  const phone = order.customer_phone;
  const messages = await resolveMessages(phone);
  await sendWhatsAppButtons(phone, messages.agent.stockUnavailable(order.product_name, order.reference), messages.agent.stockUnavailableButtons);
  await savePendingStockUnavailableOffer(phone, {
    orderNumber,
    productId: order.product_id,
    productName: order.product_name,
  });
}

/**
 * Handles the customer's yes/no reply to a pending "stock unavailable — want
 * alternatives or the waitlist?" offer. Yes re-runs the search for the same
 * part name, excluding the declined product so it can't show back up as its
 * own "alternative"; no adds them to that product's waitlist instead.
 */
export async function processStockUnavailableChoice(
  phone: string,
  reply: string,
  offer: PendingStockUnavailableOffer,
  customerName: string
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await clearPendingStockUnavailableOffer(phone);
    const options = await searchProductsInInventory({ part: offer.productName, excludeProductId: offer.productId });
    if (!options.length) {
      // No alternatives either — offer to waitlist them for the exact product
      // that was just declined, same as the main no-stock-found path.
      await sendWhatsAppButtons(phone, messages.agent.noStockFound(), messages.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: offer.productId, productName: offer.productName });
      return true;
    }
    await savePendingOptions(phone, options);
    await sendWhatsAppList(
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
    await sendWhatsAppMessage(phone, messages.agent.waitlistConfirmed(offer.productName));
    return true;
  }
  return false; // leave the offer pending; let the message fall through to normal processing
}

/**
 * Handles a reply from a number in admin_users (whatsapp.controller.ts's
 * admin short-circuit routes here before any customer-pipeline logic runs).
 * MVP is button-only — the order number is decoded straight from the button's
 * reply id (admin_confirm_${orderNumber} / admin_unavailable_${orderNumber},
 * see notifyAdminsStockConfirmationNeeded above), never from free text, since
 * this drives a real approve/decline on a customer's order. Re-checks the
 * order's current status before acting so a double-tap (or two admins both
 * replying to the same order) is a safe no-op on the second attempt, not a
 * duplicate proforma/decline.
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
 * Sweep for the 20-minute "still confirming with the supplier" courtesy
 * message — polled on an interval from index.ts since this repo has no job
 * queue. Idempotent per order via stock_confirmation_courtesy_sent, so a
 * missed/late tick after a restart just sends it a bit late, never twice.
 */
export async function sendStockConfirmationCourtesyMessages(): Promise<void> {
  const overdue = await getOrdersAwaitingCourtesyMessage(20);
  for (const order of overdue) {
    try {
      const messages = await resolveMessages(order.customer_phone);
      await sendWhatsAppMessage(order.customer_phone, messages.agent.stockConfirmationCourtesy());
      await markCourtesyMessageSent(order.number);
    } catch (error: any) {
      logger.error(`Error sending stock-confirmation courtesy message for order ${order.number}`, error);
    }
  }
}

/**
 * Sweep for the 15-minute admin SLA reminder — same shape/idempotency pattern
 * as sendStockConfirmationCourtesyMessages above (stock_confirmation_admin_reminder_sent
 * instead of the customer's own courtesy flag), fanned out to every admin.
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
 * Creates an order for a specific, already-resolved product and either offers
 * its attached service as a sequential follow-up (leaving the proforma/payment
 * for processServiceOptIn to finish once they answer) or, when there's no
 * service to offer, hands it straight to requestStockConfirmation. Shared by
 * processProductSelection (customer picked from a search list) and
 * processRestockOrderChoice (customer tapped "Order now" on a restock alert) —
 * both know exactly which product they mean, just via different paths.
 */
async function startOrderForProduct(phone: string, product: Product): Promise<void> {
  const messages = await resolveMessages(phone);
  const orderNumber = await generateOrderNumber();
  await createOrder(orderNumber, phone, product);

  if (product.service_offered && product.service_name && product.service_price) {
    await sendWhatsAppMessage(phone, messages.agent.productSelected(product.name, formatPrice(product.price)));
    await savePendingServiceOffer(phone, {
      orderNumber,
      product,
      serviceName: product.service_name,
      servicePrice: product.service_price,
    });
    await sendWhatsAppButtons(
      phone,
      messages.agent.serviceOfferBody(product.service_name, formatPrice(product.service_price)),
      messages.agent.serviceOfferButtons
    );
    return;
  }

  await requestStockConfirmation(phone, orderNumber);
}

/**
 * Handles the customer's reply to a just-shown product list — resolves which
 * option they picked and hands it to startOrderForProduct. Returns false (not
 * handled) when the reply doesn't look like a selection at all, so the
 * pipeline can fall through to a fresh search instead of a dead-end "didn't
 * understand" reply.
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
    await sendWhatsAppMessage(phone, messages.agent.optionNotFound());
    return true;
  }

  // Options consumed — prevent a stale reply from creating a duplicate order
  await clearPendingOptions(phone);

  await startOrderForProduct(phone, choice);
  return true;
}

/**
 * Handles the customer's yes/no reply to a pending "want to add this
 * service to your order?" offer — adds the service to the order (or not),
 * then either way hands the now-final order off for stock confirmation
 * (see requestStockConfirmation), same yes/no detection as
 * processWaitlistOptIn below.
 */
export async function processServiceOptIn(
  phone: string,
  reply: string,
  offer: PendingServiceOffer
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await addServiceToOrder(offer.orderNumber, offer.serviceName, offer.servicePrice);
    await clearPendingServiceOffer(phone);
    // Both sides come straight from a NUMERIC DB column via pg, which returns
    // those as strings, not numbers — "+" on two strings concatenates
    // ("15650.00" + "5000.00" -> "15650.005000.00") instead of summing, and
    // formatPrice's Number() coercion then fails to parse that as NaN.
    const total = Number(offer.product.price) + Number(offer.servicePrice);
    await sendWhatsAppMessage(phone, messages.agent.serviceAdded(offer.serviceName, formatPrice(total)));
    await requestStockConfirmation(phone, offer.orderNumber);
    return true;
  }
  if (isNo) {
    await clearPendingServiceOffer(phone);
    await sendWhatsAppMessage(phone, messages.agent.serviceDeclined());
    await requestStockConfirmation(phone, offer.orderNumber);
    return true;
  }
  return false; // leave the offer pending; let the message fall through to normal processing
}

/**
 * Handles the customer's yes/no reply to a pending "want me to notify you
 * when this product is back in stock?" offer.
 */
export async function processWaitlistOptIn(
  phone: string,
  reply: string,
  offer: { productId: number; productName: string }
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await addToProductWaitlist(offer.productId, phone);
    await clearPendingWaitlistOffer(phone);
    await sendWhatsAppMessage(phone, messages.agent.waitlistConfirmed(offer.productName));
    return true;
  }
  if (isNo) {
    await clearPendingWaitlistOffer(phone);
    await sendWhatsAppMessage(phone, messages.agent.waitlistDeclined());
    return true;
  }
  return false; // leave the offer pending; let the message fall through to normal processing
}

/**
 * Notifies every customer who opted in to a product's waitlist that it's
 * back in stock, with a Sim/Não-style "order now?" offer attached — matches
 * the doc's rich restock message (vehicle, price, supplier) instead of a bare
 * text ping. Best-effort per send — one failure must not block the rest.
 */
export async function notifyWaitlistedCustomers(restockNotifications: RestockNotification[]): Promise<void> {
  for (const { productId, productName, phones } of restockNotifications) {
    const product = await getProductById(productId);
    if (!product) continue; // deactivated/removed between the import and this notification pass

    for (const phone of phones) {
      try {
        const customer = await getCustomerByPhone(phone);
        const firstName = customer?.name?.split(' ')[0] || 'Cliente';
        const messages = getMessages(await resolveLocale(phone));

        const vehicles = await getCustomerVehicles(phone);
        const vehicleSummary = vehicles.length ? `${vehicles[0].make} ${vehicles[0].model} ${vehicles[0].year}` : null;

        await sendWhatsAppButtons(
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

/**
 * Handles the customer's yes/no reply to a "your waitlisted product is back
 * in stock — order now?" offer. Yes re-fetches the product fresh (it may have
 * sold out again between the notification and this reply) and starts an order
 * for it exactly like picking it from a search list; no just dismisses.
 */
export async function processRestockOrderChoice(
  phone: string,
  reply: string,
  offer: { productId: number; productName: string }
): Promise<boolean> {
  const messages = await resolveMessages(phone);
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await clearPendingRestockOrderOffer(phone);
    const product = await getProductById(offer.productId);
    if (!product || product.quantity <= 0) {
      // Raced — sold out again between the notification and this reply. Put them
      // straight back on the waitlist rather than losing the request entirely.
      // waitlistConfirmed (not noStockFound) since this re-add already happened —
      // asking "want me to do that?" would be misleading about something already done.
      await addToProductWaitlist(offer.productId, phone);
      await sendWhatsAppMessage(phone, messages.agent.waitlistConfirmed(offer.productName));
      return true;
    }
    await startOrderForProduct(phone, product);
    return true;
  }
  if (isNo) {
    await clearPendingRestockOrderOffer(phone);
    await sendWhatsAppMessage(phone, messages.agent.waitlistDeclined());
    return true;
  }
  return false; // leave the offer pending; let the message fall through to normal processing
}

export interface InventoryImportResult {
  inserted: number;
  updated: number;
  deactivated: number;
  restockNotifications: RestockNotification[];
}

/**
 * Bulk-imports already-parsed items (used directly by the JSON-body batch
 * endpoint, and by importInventoryFromFile below once it's parsed a
 * spreadsheet into the same shape), then notifies any waitlisted customers
 * whose product just came back in stock.
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
  reference: ['reference', 'referencia', 'ref', 'sku'],
  name: ['name', 'nome', 'descricao', 'description', 'descrição'],
  price: ['price', 'preco', 'preço'],
  quantity: ['quantity', 'quantidade', 'qty', 'stock'],
  supplierName: ['supplier', 'supplier_name', 'fornecedor', 'nome_fornecedor'],
  supplierNif: ['supplier_nif', 'nif_fornecedor'],
  supplierProvince: ['supplier_province', 'provincia_fornecedor'],
  service: ['service', 'servico', 'serviço'],
  serviceName: ['service_name', 'nome_servico', 'nome_serviço'],
  servicePrice: ['service_price', 'preco_servico', 'preço_serviço'],
};

// Values a CSV/XLSX author would plausibly type in the "service: yes/no" column.
const YES_VALUES = new Set(['yes', 'sim', 'true', '1']);

// Column presence is checked against the header row before any row is read —
// every one of these must have at least one alias in the file, or the whole
// upload is rejected up front (see getMissingRequiredColumns).
const REQUIRED_COLUMNS: { field: 'reference' | 'name' | 'price' | 'quantity' | 'supplierName'; label: string }[] = [
  { field: 'reference', label: 'Reference' },
  { field: 'name', label: 'Name' },
  { field: 'price', label: 'Price' },
  { field: 'quantity', label: 'Quantity' },
  { field: 'supplierName', label: 'Supplier' },
];

/**
 * Checks the file's header row (not the data rows — a required column that's
 * present but blank on every row is a row-level problem, handled separately
 * by validateRow) against REQUIRED_COLUMNS, returning the human-readable
 * labels of whichever are entirely missing so the caller can reject the file
 * with one clear message instead of a per-row guessing game.
 */
function getMissingRequiredColumns(headerRow: unknown[]): string[] {
  const headerSet = new Set(headerRow.map((h) => String(h ?? '').trim().toLowerCase()));
  return REQUIRED_COLUMNS.filter(({ field }) => !HEADER_ALIASES[field].some((alias) => headerSet.has(alias))).map(
    ({ label }) => label
  );
}

/**
 * Validates one spreadsheet row and either returns the item ready to import
 * or the list of problems found. Reference, Name, Price, Quantity and
 * Supplier are always required; Service Name/Price are only required when
 * Service is "yes" — a row that sets Service = yes but leaves the price out
 * is an error, not a silently-dropped service (see importInventoryFromFile:
 * any row error rejects the whole file, nothing is written until it's clean).
 */
function validateRow(row: Record<string, any>, rowNumber: number): { item: ImportItem } | { errors: string[] } {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') return lowerRow[alias];
    }
    return undefined;
  };

  const errors: string[] = [];

  const reference = pick('reference');
  if (!reference) errors.push(`Row ${rowNumber}: Reference is required.`);

  const name = pick('name');
  if (!name) errors.push(`Row ${rowNumber}: Name is required.`);

  const priceRaw = pick('price');
  const price = Number(priceRaw);
  if (priceRaw === undefined || Number.isNaN(price) || price < 0) {
    errors.push(`Row ${rowNumber}: Price is required and must be a non-negative number.`);
  }

  const quantityRaw = pick('quantity');
  const quantity = Number(quantityRaw);
  if (quantityRaw === undefined || !Number.isInteger(quantity) || quantity < 0) {
    errors.push(`Row ${rowNumber}: Quantity is required and must be a non-negative whole number.`);
  }

  const supplierName = pick('supplierName');
  if (!supplierName) errors.push(`Row ${rowNumber}: Supplier is required.`);

  const wantsService = YES_VALUES.has(String(pick('service') ?? '').trim().toLowerCase());
  const serviceName = pick('serviceName');
  const servicePriceRaw = pick('servicePrice');
  const servicePrice = Number(servicePriceRaw);
  if (wantsService && !serviceName) {
    errors.push(`Row ${rowNumber}: Service Name is required when Service is "yes".`);
  }
  if (wantsService && (servicePriceRaw === undefined || Number.isNaN(servicePrice) || servicePrice < 0)) {
    errors.push(`Row ${rowNumber}: Service Price is required and must be a non-negative number when Service is "yes".`);
  }

  if (errors.length) return { errors };

  return {
    item: {
      reference: String(reference),
      name: String(name),
      price,
      quantity,
      supplierName: String(supplierName),
      supplierNif: pick('supplierNif') ? String(pick('supplierNif')) : undefined,
      supplierProvince: pick('supplierProvince') ? String(pick('supplierProvince')) : undefined,
      serviceOffered: wantsService,
      serviceName: wantsService ? String(serviceName) : undefined,
      servicePrice: wantsService ? servicePrice : undefined,
    },
  };
}

// Caps how many row errors get spelled out in the 400 response — a
// 500-row file with a header typo would otherwise repeat the same five
// errors 500 times over.
const MAX_ROW_ERRORS_SHOWN = 20;

/**
 * Parses a single uploaded CSV/XLSX file and imports every row, each row
 * naming its own supplier (created on the fly by name if it doesn't exist
 * yet). Column headers map via HEADER_ALIASES so PT/EN header variants both
 * work. Validates in two passes before writing anything: first the header
 * row against REQUIRED_COLUMNS (missing columns reject the file immediately,
 * naming them), then every data row (bad/missing price, quantity, supplier,
 * or an incomplete service) — any row problem rejects the whole file with
 * every problem listed, so nothing partially imports.
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
  const rowErrors: string[] = [];
  rawRows.forEach((row, i) => {
    // +2: the header is row 1 in the spreadsheet, so the first data row is row 2.
    const result = validateRow(row, i + 2);
    if ('errors' in result) rowErrors.push(...result.errors);
    else items.push(result.item);
  });

  if (rowErrors.length) {
    const shown = rowErrors.slice(0, MAX_ROW_ERRORS_SHOWN).join(' ');
    const suffix = rowErrors.length > MAX_ROW_ERRORS_SHOWN ? ` (+${rowErrors.length - MAX_ROW_ERRORS_SHOWN} more)` : '';
    throw new ApiError(400, `${shown}${suffix}`);
  }

  return importInventoryBatch(items, null);
}
