import { logger } from '../config/logger.js';
import {
  searchProductsInInventory,
  addToProductWaitlist,
  findZeroQuantityProductMatch,
  Product
} from '../models/product.model.js';
import { RestockNotification } from '../models/supplier.model.js';
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
