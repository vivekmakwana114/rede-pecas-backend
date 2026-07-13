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
  getOrCreateSupplierByName,
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
  markCourtesyMessageSent
} from '../models/order.model.js';
import { getCustomerVehicles } from '../models/vehicle.model.js';
import { getCustomerByPhone } from '../models/customer.model.js';
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
import { t } from '../i18n/messages.js';

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
  logger.info(`[PRODUCT SEARCH] ${phone} searching for: "${customerText}"`);
  await sendWhatsAppMessage(phone, t.agent.checkingStock());

  const options = await searchProductsInInventory({ part: customerText });

  if (!options || options.length === 0) {
    logger.info(`[PRODUCT SEARCH] ${phone} no matches for "${customerText}"`);

    const candidate = await findZeroQuantityProductMatch({ part: customerText });
    if (candidate) {
      // Only attach the "want to be notified?" buttons when there's an actual
      // out-of-stock product to attach them to — tapping "yes" with nothing to
      // wait on would be a dead end.
      logger.info(`[PRODUCT SEARCH] ${phone} offering waitlist for out-of-stock match: ${candidate.name}`);
      await sendWhatsAppButtons(phone, t.agent.noStockFound(), t.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name });
    } else {
      await sendWhatsAppMessage(phone, t.agent.noStockFound());
    }
    return;
  }

  logger.info(`[PRODUCT SEARCH] ${phone} found ${options.length} match(es) for "${customerText}": ${options.map(o => o.name).join(', ')}`);

  // Persist results so the customer's list tap / typed digit in the next message can resolve them
  await savePendingOptions(phone, options);

  const vehicle = await resolveSearchVehicle(phone);
  const body = vehicle
    ? t.agent.searchListBodyForVehicle(options.length, customerText, vehicle.make, vehicle.model, vehicle.year, customerName)
    : t.agent.searchListBody(options.length, customerText, customerName);
  await sendWhatsAppList(phone, body, t.agent.searchListButton(), buildProductListRows(options));
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
      `Ref: ${item.reference} • ${formatPrice(item.price)} • ${t.agent.stockCountLabel(item.quantity)} • ${item.delivery_time}${item.supplier ? ` • ${item.supplier}` : ''}`,
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
  await updateOrderStatus(orderNumber, 'awaiting_stock_confirmation');
  await sendWhatsAppMessage(phone, t.agent.confirmingAvailability());
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
  await sendWhatsAppMessage(phone, t.agent.stockConfirmedIntro(product.name, firstName));

  const proformaPath = await generateProformaPDF(orderNumber, phone, product, service);
  await sendProformaWhatsApp(phone, proformaPath, orderNumber);
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
  await sendWhatsAppButtons(phone, t.agent.stockUnavailable(order.product_name, order.reference), t.agent.stockUnavailableButtons);
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
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await clearPendingStockUnavailableOffer(phone);
    const options = await searchProductsInInventory({ part: offer.productName, excludeProductId: offer.productId });
    if (!options.length) {
      // No alternatives either — offer to waitlist them for the exact product
      // that was just declined, same as the main no-stock-found path.
      await sendWhatsAppButtons(phone, t.agent.noStockFound(), t.agent.noStockFoundButtons);
      await savePendingWaitlistOffer(phone, { productId: offer.productId, productName: offer.productName });
      return true;
    }
    await savePendingOptions(phone, options);
    await sendWhatsAppList(
      phone,
      t.agent.searchListBody(options.length, offer.productName, customerName),
      t.agent.searchListButton(),
      buildProductListRows(options)
    );
    return true;
  }
  if (isNo) {
    await clearPendingStockUnavailableOffer(phone);
    await addToProductWaitlist(offer.productId, phone);
    await sendWhatsAppMessage(phone, t.agent.waitlistConfirmed(offer.productName));
    return true;
  }
  return false; // leave the offer pending; let the message fall through to normal processing
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
      await sendWhatsAppMessage(order.customer_phone, t.agent.stockConfirmationCourtesy());
      await markCourtesyMessageSent(order.number);
    } catch (error: any) {
      logger.error(`Error sending stock-confirmation courtesy message for order ${order.number}`, error);
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
  const orderNumber = await generateOrderNumber();
  await createOrder(orderNumber, phone, product);

  if (product.service_offered && product.service_name && product.service_price) {
    await sendWhatsAppMessage(phone, t.agent.productSelected(product.name, formatPrice(product.price)));
    await savePendingServiceOffer(phone, {
      orderNumber,
      product,
      serviceName: product.service_name,
      servicePrice: product.service_price,
    });
    await sendWhatsAppButtons(
      phone,
      t.agent.serviceOfferBody(product.service_name, formatPrice(product.service_price)),
      t.agent.serviceOfferButtons
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
    await sendWhatsAppMessage(phone, t.agent.optionNotFound());
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
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await addServiceToOrder(offer.orderNumber, offer.serviceName, offer.servicePrice);
    await clearPendingServiceOffer(phone);
    const total = offer.product.price + offer.servicePrice;
    await sendWhatsAppMessage(phone, t.agent.serviceAdded(offer.serviceName, formatPrice(total)));
    await requestStockConfirmation(phone, offer.orderNumber);
    return true;
  }
  if (isNo) {
    await clearPendingServiceOffer(phone);
    await sendWhatsAppMessage(phone, t.agent.serviceDeclined());
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
  const r = reply.toLowerCase();
  const isYes = r.includes('sim') || r.includes('yes') || r === '1' || r.includes('✅') || r.includes('btn_0');
  const isNo = r.includes('não') || r.includes('nao') || r === '2' || r.includes('❌') || r.includes('btn_1');

  if (isYes) {
    await addToProductWaitlist(offer.productId, phone);
    await clearPendingWaitlistOffer(phone);
    await sendWhatsAppMessage(phone, t.agent.waitlistConfirmed(offer.productName));
    return true;
  }
  if (isNo) {
    await clearPendingWaitlistOffer(phone);
    await sendWhatsAppMessage(phone, t.agent.waitlistDeclined());
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

        const vehicles = await getCustomerVehicles(phone);
        const vehicleSummary = vehicles.length ? `${vehicles[0].make} ${vehicles[0].model} ${vehicles[0].year}` : null;

        await sendWhatsAppButtons(
          phone,
          t.agent.restockNotification(firstName, productName, vehicleSummary, formatPrice(product.price), product.supplier || ''),
          t.agent.restockNotificationButtons
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
      await sendWhatsAppMessage(phone, t.agent.waitlistConfirmed(offer.productName));
      return true;
    }
    await startOrderForProduct(phone, product);
    return true;
  }
  if (isNo) {
    await clearPendingRestockOrderOffer(phone);
    await sendWhatsAppMessage(phone, t.agent.waitlistDeclined());
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

/**
 * Maps one spreadsheet row to an import item. Supplier columns are optional —
 * a row without them falls back to the request-level default supplier
 * (importInventoryBatch/importProductsBatch handle that fallback), so a
 * single-supplier file doesn't need to repeat the supplier on every row.
 *
 * The service columns fail soft: a row with `service = yes` but a missing/invalid
 * service_name or service_price still imports the product — just without the
 * service attached — rather than discarding the whole row over a bad sub-field.
 */
function normalizeRow(row: Record<string, any>): ImportItem | null {
  const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const pick = (field: string) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') return lowerRow[alias];
    }
    return undefined;
  };
  const reference = pick('reference');
  const name = pick('name');
  const price = Number(pick('price'));
  const quantity = Number(pick('quantity'));
  if (!reference || !name || Number.isNaN(price) || Number.isNaN(quantity)) return null;

  const supplierName = pick('supplierName');

  const wantsService = YES_VALUES.has(String(pick('service') ?? '').trim().toLowerCase());
  const serviceName = pick('serviceName');
  const servicePrice = Number(pick('servicePrice'));
  const serviceValid = wantsService && !!serviceName && !Number.isNaN(servicePrice);
  if (wantsService && !serviceValid) {
    logger.warn(
      `[INVENTORY IMPORT] Row for reference="${reference}" has service=yes but an invalid/missing service_name or service_price — importing the product without the service.`
    );
  }

  return {
    reference: String(reference),
    name: String(name),
    price,
    quantity,
    supplierName: supplierName ? String(supplierName) : undefined,
    supplierNif: pick('supplierNif') ? String(pick('supplierNif')) : undefined,
    supplierProvince: pick('supplierProvince') ? String(pick('supplierProvince')) : undefined,
    serviceOffered: serviceValid,
    serviceName: serviceValid ? String(serviceName) : undefined,
    servicePrice: serviceValid ? servicePrice : undefined,
  };
}

/**
 * Parses an uploaded CSV/XLSX file buffer, resolves the request-level fallback
 * supplier if given (existing id, or name/nif/province to create one on the
 * fly), imports every row (each optionally naming its own supplier), and
 * notifies waitlisted customers. Column headers map via HEADER_ALIASES so
 * PT/EN header variants both work.
 */
export async function importInventoryFromFile(
  fileBuffer: Buffer,
  supplierFallback: { supplierId?: string | number; supplierName?: string; supplierNif?: string; supplierProvince?: string }
): Promise<InventoryImportResult> {
  let defaultSupplierId: number | null = null;
  if (supplierFallback.supplierId) {
    defaultSupplierId = Number(supplierFallback.supplierId);
  } else if (supplierFallback.supplierName) {
    defaultSupplierId = await getOrCreateSupplierByName(
      supplierFallback.supplierName,
      supplierFallback.supplierNif,
      supplierFallback.supplierProvince
    );
  }

  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);

  const items = rawRows
    .map(normalizeRow)
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (!items.length) {
    throw new ApiError(400, 'No valid rows found in the file (check column headers).');
  }

  return importInventoryBatch(items, defaultSupplierId);
}
