import * as XLSX from 'xlsx';
import fs from 'fs';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import {
  searchProductsInInventory,
  addToProductWaitlist,
  findZeroQuantityProductMatch,
  Product
} from '../models/product.model.js';
import {
  importProductsBatch,
  getOrCreateSupplierByName,
  ImportItem,
  RestockNotification
} from '../models/supplier.model.js';
import { createOrder, generateOrderNumber } from '../models/order.model.js';
import { getCustomerVehicles } from '../models/vehicle.model.js';
import { sendWhatsAppMessage, sendWhatsAppList } from './whatsapp.service.js';
import { generateProformaPDF, sendProformaWhatsApp } from './pdf.service.js';
import { askPaymentMethod } from './payment.service.js';
import {
  savePendingOptions,
  clearPendingOptions,
  savePendingWaitlistOffer,
  clearPendingWaitlistOffer,
  getChosenVehicle
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
export async function searchAndRespond(phone: string, customerText: string): Promise<void> {
  await sendWhatsAppMessage(phone, t.agent.checkingStock());

  const options = await searchProductsInInventory({ part: customerText });

  if (!options || options.length === 0) {
    await sendWhatsAppMessage(phone, t.agent.noStockFound());

    const candidate = await findZeroQuantityProductMatch({ part: customerText });
    if (candidate) {
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name });
    }
    return;
  }

  // Persist results so the customer's list tap / typed digit in the next message can resolve them
  await savePendingOptions(phone, options);

  const vehicle = await resolveSearchVehicle(phone);
  const body = vehicle
    ? t.agent.searchListBodyForVehicle(options.length, customerText, vehicle.make, vehicle.model, vehicle.year)
    : t.agent.searchListBody(options.length, customerText);
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
      `${formatPrice(item.price)} • ${item.delivery_time}${item.supplier ? ` • ${item.supplier}` : ''}`,
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
 * Handles the customer's reply to a just-shown product list — creates the
 * order, sends the proforma PDF, and kicks off the payment-method flow.
 * Returns false (not handled) when the reply doesn't look like a selection
 * at all, so the pipeline can fall through to a fresh search instead of a
 * dead-end "didn't understand" reply.
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

  const orderNumber = await generateOrderNumber();
  await createOrder(orderNumber, phone, choice);

  const proformaPath = await generateProformaPDF(orderNumber, phone, choice);
  await sendProformaWhatsApp(phone, proformaPath, orderNumber, choice);
  await askPaymentMethod(phone, orderNumber, choice.price);

  // Options consumed — prevent a stale reply from creating a duplicate order
  await clearPendingOptions(phone);

  // Clean temp PDF asynchronously
  setTimeout(() => {
    try {
      fs.unlinkSync(proformaPath);
    } catch {
      // best-effort cleanup, ignore if already removed
    }
  }, 60000);

  return true;
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
 * back in stock. Best-effort per send — one failure must not block the rest.
 */
export async function notifyWaitlistedCustomers(restockNotifications: RestockNotification[]): Promise<void> {
  for (const { productName, phones } of restockNotifications) {
    for (const phone of phones) {
      try {
        await sendWhatsAppMessage(phone, t.agent.restockNotification(productName));
      } catch (error: any) {
        logger.error(`Error sending restock notification to ${phone} for product ${productName}`, error);
      }
    }
  }
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
};

/**
 * Maps one spreadsheet row to an import item. Supplier columns are optional —
 * a row without them falls back to the request-level default supplier
 * (importInventoryBatch/importProductsBatch handle that fallback), so a
 * single-supplier file doesn't need to repeat the supplier on every row.
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

  return {
    reference: String(reference),
    name: String(name),
    price,
    quantity,
    supplierName: supplierName ? String(supplierName) : undefined,
    supplierNif: pick('supplierNif') ? String(pick('supplierNif')) : undefined,
    supplierProvince: pick('supplierProvince') ? String(pick('supplierProvince')) : undefined,
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
