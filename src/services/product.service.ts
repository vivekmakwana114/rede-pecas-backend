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
 * match against name/brand/reference/synonyms — no AI involved), hard-filtered
 * to products compatible with the customer's registered vehicle (see
 * searchProductsInInventory's vehicle param), and either sends a tappable
 * list of the up-to-3 cheapest compatible matches, or — on no matches —
 * offers to waitlist the customer against the closest out-of-stock match.
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
      // Only attach the "want to be notified?" buttons when there's an actual
      // out-of-stock product to attach them to — tapping "yes" with nothing to
      // wait on would be a dead end.
      logger.info(`[PRODUCT SEARCH] ${phone} offering waitlist for out-of-stock match: ${candidate.name}`);
      await sendReplyButtons(phone, messages.agent.noStockFound(), messages.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name, query: customerText });
    } else {
      // Not contextual: noStockFound() is a fixed "no stock, want the waitlist?"
      // notice that doesn't need to react to what the customer searched for — and
      // folding in their (often vague) search text as context invited Claude to
      // "helpfully" add a clarifying ask that isn't in the source string at all,
      // once inventing "tell me the name or send a photo" — product search has no
      // photo-identification path (that only exists for vehicle documents), so
      // that instruction was simply wrong on top of not being in the original.
      await sendReply(phone, messages.agent.noStockFound());
    }
    return;
  }

  logger.info(`[PRODUCT SEARCH] ${phone} found ${options.length} match(es) for "${customerText}": ${options.map(o => o.name).join(', ')}`);

  // Persist results so the customer's list tap / typed digit in the next message can resolve them
  await savePendingOptions(phone, options);

  const body = vehicle
    ? messages.agent.searchListBodyForVehicle(options.length, customerText, vehicle.make, vehicle.model, vehicle.year, customerName)
    : messages.agent.searchListBody(options.length, customerText, customerName);
  await sendReplyList(phone, body, messages.agent.searchListButton(), buildProductListRows(options));
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
      `Ref: ${item.reference} • ${formatPrice(item.price)}${item.supplier ? ` • ${item.supplier}` : ''}`,
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
 * Builds the tappable list rows for the services matched to a product (see
 * getMatchingServicesForProduct — same service_category join key as
 * products.service_category), cheapest first, plus one extra "no thanks" row
 * appended at the end so declining is a normal list selection rather than a
 * separate yes/no gate.
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
 * Resolves a reply against a just-shown service list to either a services[]
 * index, 'skip' (explicit decline — the appended last row, or a typed
 * "não"/"no" phrase regardless of row position), or null when the reply
 * isn't shaped like a selection at all (letting the pipeline fall through —
 * this is one of the 4 "pending offer" prompts documented in CLAUDE.md that
 * deliberately keep that fall-through behavior instead of re-asking).
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
  await sendReply(phone, messages.agent.confirmingAvailability());
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
  await sendReplyButtons(phone, messages.agent.stockUnavailable(order.product_name, order.reference), messages.agent.stockUnavailableButtons);
  await savePendingStockUnavailableOffer(phone, {
    orderNumber,
    productId: order.product_id,
    productName: order.product_name,
  });
}

// Generic affirmative/negative wording (PT + EN), shared by every "pending
// offer" yes/no reply below (stock-unavailable alternatives, waitlist notify,
// restock re-order). A customer very often doesn't tap the button and just
// types a natural reply instead — relying on the bare button text alone
// ('sim'/'yes'/'1'/✅/btn_0) missed common phrasings like "add me to the
// waitlist" or "yes please", silently falling through to a fresh
// (nonsensical) product search instead of being recognized as an answer to
// the offer. Each call site passes its own extra phrases on top of this,
// since the same word can mean opposite things in different offers — e.g.
// "waitlist" is the YES answer to "want to be notified?"
// (processWaitlistOptIn) but the NO answer to "alternatives, or join the
// waitlist?" (processStockUnavailableChoice) — so it's never folded into
// this shared generic set.
const GENERIC_YES_PATTERN = /\b(sim|yes|yeah|yep|yup|sure|ok(ay)?|certo|pode|podes|quero|aceito|est[áa]\s*bem)\b/i;
const GENERIC_NO_PATTERN = /\b(n[ãa]o|no|nope|not\s*(interested|now)|dispensa)\b/i;

function isAffirmativeReply(reply: string, extra?: RegExp): boolean {
  const r = reply.toLowerCase().trim();
  if (r === '1' || r.includes('✅') || r.includes('btn_0')) return true;
  if (GENERIC_YES_PATTERN.test(r)) return true;
  return extra ? extra.test(r) : false;
}

function isNegativeReply(reply: string, extra?: RegExp): boolean {
  const r = reply.toLowerCase().trim();
  if (r === '2' || r.includes('❌') || r.includes('btn_1')) return true;
  if (GENERIC_NO_PATTERN.test(r)) return true;
  return extra ? extra.test(r) : false;
}

// stockUnavailableButtons: ['✅ Alternatives'/'Alternativas', '❌ Join
// waitlist'/'Lista de espera'] — "waitlist" here means NO (decline
// alternatives, wait for this exact product instead), the opposite of its
// meaning in processWaitlistOptIn below.
const STOCK_UNAVAILABLE_YES_EXTRA = /\b(alternative|alternativa|other\s*option|outra\s*op[çc][ãa]o)\b/i;
const STOCK_UNAVAILABLE_NO_EXTRA = /\b(wait\s*list|waitlist|join\s*(the\s*)?waitlist|lista\s*de\s*espera)\b/i;

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
  const isYes = isAffirmativeReply(reply, STOCK_UNAVAILABLE_YES_EXTRA);
  const isNo = isNegativeReply(reply, STOCK_UNAVAILABLE_NO_EXTRA);

  if (isYes) {
    await clearPendingStockUnavailableOffer(phone);
    const vehicle = await resolveSearchVehicle(phone);
    const options = await searchProductsInInventory({ part: offer.productName, vehicle, excludeProductId: offer.productId });
    if (!options.length) {
      // No alternatives either — offer to waitlist them for the exact product
      // that was just declined, same as the main no-stock-found path.
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
      await sendReply(order.customer_phone, messages.agent.stockConfirmationCourtesy());
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
 * Creates an order for a specific, already-resolved product, then looks up
 * the services that share this product's service_category (see
 * getMatchingServicesForProduct — products.service_category = the derived
 * subcategory grouping, services.service_category = the CSV's own value;
 * db/schema.sql). When there's at least one match, offers them as a tappable
 * list (leaving the proforma/payment for processServiceSelection to finish
 * once the customer picks one or declines) — otherwise hands the order
 * straight to requestStockConfirmation with just the product. Shared by
 * processProductSelection (customer picked from a search list) and
 * processRestockOrderChoice (customer tapped "Order now" on a restock alert) —
 * both know exactly which product they mean, just via different paths.
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
    await sendReply(phone, messages.agent.optionNotFound());
    return true;
  }

  // Options consumed — prevent a stale reply from creating a duplicate order
  await clearPendingOptions(phone);

  await startOrderForProduct(phone, choice);
  return true;
}

/**
 * Handles the customer's reply to a pending "here are the services related
 * to your product — want to add one?" list — adds the picked service to the
 * order (or not, if they picked the appended "no thanks" row / typed a
 * decline), then either way hands the now-final order off for stock
 * confirmation (see requestStockConfirmation). Returns false (leaving the
 * offer pending) when the reply doesn't resolve to a selection at all — this
 * is one of the 4 "pending offer" prompts (CLAUDE.md) that deliberately keep
 * that fall-through behavior instead of re-asking, since an unmatched reply
 * here is more likely a genuinely new request than a misunderstood answer.
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
  // Both sides come straight from a NUMERIC DB column via pg, which returns
  // those as strings, not numbers — "+" on two strings concatenates
  // ("15650.00" + "5000.00" -> "15650.005000.00") instead of summing, and
  // formatPrice's Number() coercion then fails to parse that as NaN.
  const total = Number(offer.product.price) + Number(chosen.service_base_price);
  await sendReply(phone, messages.agent.serviceAdded(chosen.service_name, formatPrice(total)));
  await requestStockConfirmation(phone, offer.orderNumber);
  return true;
}

// noStockFoundButtons: ['✅ Yes, notify me'/'Sim, avisa-me', '❌ No,
// thanks'/'Não, obrigado'] — "waitlist" here means YES (they want to be
// notified), the opposite of its meaning in processStockUnavailableChoice
// above. This is the exact phrasing a customer typing instead of tapping the
// button reaches for ("add me to the waitlist", "notify me").
const WAITLIST_YES_EXTRA = /\b(add\s*me|notify\s*me|wait\s*list|waitlist|join\s*(the\s*)?waitlist|avisa[- ]?me|lista\s*de\s*espera)\b/i;

/**
 * Handles the customer's yes/no reply to a pending "want me to notify you
 * when this product is back in stock?" offer.
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
    // Echoes the customer's own search text when this offer came from a free-
    // text search (query set — see searchAndRespond), rather than the
    // specific resolved product's real name, which can read as a mismatch
    // when their query was vague. Falls back to productName for the other
    // two callers (declined-stock alternatives, restock re-offer), which
    // never set query since they already know the exact product from a list
    // tap, not free text.
    await sendReply(phone, messages.agent.waitlistConfirmed(offer.query ?? offer.productName));
    return true;
  }
  if (isNo) {
    await clearPendingWaitlistOffer(phone);
    await sendReply(phone, messages.agent.waitlistDeclined());
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

// restockNotificationButtons: ['✅ Order now'/'Pedir agora', '❌ Not right
// now'/'Agora não'].
const RESTOCK_YES_EXTRA = /\b(order\s*now|order\s*it|pedir\s*agora|quero\s*encomendar|comprar)\b/i;
const RESTOCK_NO_EXTRA = /\b(not\s*now|maybe\s*later|agora\s*n[ãa]o)\b/i;

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
  const isYes = isAffirmativeReply(reply, RESTOCK_YES_EXTRA);
  const isNo = isNegativeReply(reply, RESTOCK_NO_EXTRA);

  if (isYes) {
    await clearPendingRestockOrderOffer(phone);
    const product = await getProductById(offer.productId);
    if (!product || product.quantity <= 0) {
      // Raced — sold out again between the notification and this reply. Put them
      // straight back on the waitlist rather than losing the request entirely.
      // waitlistConfirmed (not noStockFound) since this re-add already happened —
      // asking "want me to do that?" would be misleading about something already done.
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
  return false; // leave the offer pending; let the message fall through to normal processing
}

export interface InventoryImportResult {
  inserted: number;
  updated: number;
  restockNotifications: RestockNotification[];
  // Rows the file-upload importer (importInventoryFromFile) skipped rather
  // than rejecting the whole file for — see validateRow. Always empty for the
  // JSON-body batch endpoint (importInventoryBatch), whose items are already
  // validated by Joi before this function ever sees them.
  skipped?: { row: number; reasons: string[] }[];
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
  reference: ['sku', 'reference', 'referencia', 'ref'],
  name: ['product', 'produto', 'name', 'nome'],
  price: ['price', 'preco', 'preço'],
  quantity: ['quantity', 'quantidade', 'qty', 'stock'],
  supplierName: ['supplier name', 'supplier', 'supplier_name', 'fornecedor', 'nome_fornecedor'],
  // "Address" here is the same underlying suppliers.province DB column, just
  // relabeled — Angola supplier addresses are commonly just a province name,
  // and there's no separate address column (a deliberate choice, not a gap).
  supplierAddress: ['supplier address', 'supplier_address', 'endereco_fornecedor', 'supplier_province', 'provincia_fornecedor'],
  supplierPhone: ['supplier phone', 'supplier_phone', 'telefone_fornecedor'],
  // Catalog fields from the products CSV (produtos_rede_pecas_via_pecas_v3_EN.csv)
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

// Column presence is checked against the header row before any row is read —
// every one of these must have at least one alias in the file, or the whole
// upload is rejected up front (see getMissingRequiredColumns).
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
 * or the list of reasons this specific row can't be imported. Unlike the
 * file-level column check (getMissingRequiredColumns), a row-level problem no
 * longer blocks the whole file — importInventoryFromFile imports every valid
 * row and reports the rest as skipped, since the real catalog data
 * legitimately has some incomplete rows (missing price/description on a
 * handful of the ~700 rows) that shouldn't hold the other ~670 hostage.
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
  // year_start/year_end/interval_km are INT columns — the real catalog has a
  // handful of rows with shifted/malformed data where these fields hold
  // stray non-integer text ("2.5", "Various", "1KD/2KD"). Since these fields
  // are optional, unparseable-as-integer values are dropped to null instead
  // of either crashing on the DB insert or invalidating an otherwise-good row.
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
 * Parses a single uploaded CSV/XLSX file and imports every valid row, each
 * row naming its own supplier (created on the fly by name if it doesn't
 * exist yet). Headers map via HEADER_ALIASES so PT/EN variants and older
 * column names both still work. Two validation passes: first the header row
 * against REQUIRED_COLUMNS — a column missing entirely is a structural
 * problem and rejects the file immediately, naming what's missing. Then each
 * data row is validated independently (validateRow) — a row with a real
 * problem (missing price/description, unknown subcategory, etc.) is skipped
 * rather than blocking the rest of the file, and reported back in
 * `skipped` so the admin can see exactly what didn't import and why, without
 * every other valid row waiting on it being hand-fixed first.
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
    // +2: the header is row 1 in the spreadsheet, so the first data row is row 2.
    const rowNumber = i + 2;
    const result = validateRow(row, rowNumber);
    if ('reasons' in result) skipped.push({ row: rowNumber, reasons: result.reasons });
    else items.push(result.item);
  });

  const result = await importInventoryBatch(items, null);
  return { ...result, skipped };
}

// Column order matches the primary alias for each HEADER_ALIASES field (and
// postman/generate-test-inventory.js's sample file), so a template downloaded
// here round-trips through importInventoryFromFile unchanged once data rows
// are added.
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
 * Builds a blank XLSX workbook containing only the header row expected by
 * importInventoryFromFile — lets an admin start from a file guaranteed to
 * have the right columns instead of guessing at names.
 */
export function generateInventoryTemplateFile(): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADER_ROW]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
