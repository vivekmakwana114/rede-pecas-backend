import * as XLSX from 'xlsx';
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
import { sendWhatsAppMessage } from './whatsapp.service.js';
import {
  savePendingOptions,
  savePendingWaitlistOffer,
  clearPendingWaitlistOffer
} from './session.service.js';
import { formatPrice } from '../utils/helpers.js';
import { t } from '../i18n/messages.js';

/**
 * Searches inventory for the requested part and either sends the numbered
 * options list, or — on no stock — offers to waitlist the customer against
 * the closest out-of-stock match.
 */
export async function searchAndRespond(phone: string, action: any, history: any[]): Promise<void> {
  await sendWhatsAppMessage(phone, t.agent.checkingStock());

  const options = await searchProductsInInventory({ part: action.part });

  if (!options || options.length === 0) {
    const msg = t.agent.noStockFound();
    await sendWhatsAppMessage(phone, msg);
    history.push({ role: 'assistant', content: msg });

    const candidate = await findZeroQuantityProductMatch({ part: action.part });
    if (candidate) {
      await savePendingWaitlistOffer(phone, { productId: candidate.id, productName: candidate.name });
    }
    return;
  }

  // Persist results so the customer's numeric choice in the next message can resolve them
  await savePendingOptions(phone, options);

  const optionsMessage = formatSearchOptions(options, action);
  await sendWhatsAppMessage(phone, optionsMessage);
  history.push({ role: 'assistant', content: optionsMessage });
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

function formatSearchOptions(options: Product[], action: any): string {
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const top5 = options.slice(0, 5);

  let msg = t.agent.searchHeader(top5.length, action.part, action.vehicle_make, action.model, action.year);

  top5.forEach((item, i) => {
    msg += t.agent.searchItem({
      emoji: numberEmojis[i],
      name: item.name,
      reference: item.reference,
      price: formatPrice(item.price),
      quantity: item.quantity,
      deliveryTime: item.delivery_time,
      supplier: item.supplier,
    });
  });

  msg += t.agent.searchFooter();
  return msg;
}
