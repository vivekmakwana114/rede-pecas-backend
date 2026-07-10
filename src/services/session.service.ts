import { createClient } from 'redis';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { Product } from '../models/product.model.js';

let redisClient: any = null;
let useMemoryFallback = false;
const memoryCache = new Map<string, any[]>();

const SESSION_TTL = 60 * 60 * 4; // 4 hours in seconds
const VEHICLE_ID_CHOICE_TTL = 60 * 30; // 30 minutes — matches the manual-collection wizard's own window

if (config.redis.url) {
  try {
    redisClient = createClient({ url: config.redis.url });
    redisClient.on('error', (err: any) => {
      logger.error('Redis client error, falling back to in-memory cache', err);
      useMemoryFallback = true;
    });

    // Connect asynchronously
    redisClient.connect().then(() => {
      logger.info('Connected to Redis successfully for sessions');
    }).catch((err: any) => {
      logger.error('Failed to connect to Redis, using memory fallback', err);
      useMemoryFallback = true;
    });
  } catch (err) {
    logger.error('Failed to initialize Redis client, using memory fallback', err);
    useMemoryFallback = true;
  }
} else {
  logger.info('No REDIS_URL provided, using in-memory cache for sessions');
  useMemoryFallback = true;
}

/**
 * Persists search result options awaiting the customer's list tap or typed
 * numeric choice.
 */
export async function savePendingOptions(phone: string, options: any[]): Promise<void> {
  const key = `options:${phone}`;
  memoryCache.set(key, options);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(options));
  } catch (err) {
    logger.error('Error saving pending options to Redis', err);
  }
}

export async function getPendingOptions(phone: string): Promise<any[] | null> {
  const key = `options:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return memoryCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending options from Redis', err);
    return memoryCache.get(key) || null;
  }
}

export async function clearPendingOptions(phone: string): Promise<void> {
  const key = `options:${phone}`;
  memoryCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending options from Redis', err);
  }
}

// Tracks "have we heard from this number in the last 4h" — a plain presence marker,
// touched on every incoming message regardless of which stage of the pipeline handles it.
const activeSessions = new Map<string, number>();

export async function isNewSession(phone: string): Promise<boolean> {
  const key = `active:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = activeSessions.get(key);
    return !expiresAt || expiresAt < Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 0;
  } catch (err) {
    logger.error('Error checking session activity in Redis', err);
    const expiresAt = activeSessions.get(key);
    return !expiresAt || expiresAt < Date.now();
  }
}

export async function markSessionActive(phone: string): Promise<void> {
  const key = `active:${phone}`;
  activeSessions.set(key, Date.now() + SESSION_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, '1');
  } catch (err) {
    logger.error('Error marking session active in Redis', err);
  }
}

// Tracks "has this customer actually been asked 'what part do you need?'" (via
// onboardingComplete/collectionComplete/confirmedAskPart/sendAskPartPrompt). Free text
// is only ever treated as a product search once this is set — it must never be the
// first thing that answers a stray message.
const partPromptSessions = new Map<string, number>();

export async function wasPartPromptSent(phone: string): Promise<boolean> {
  const key = `partPrompt:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = partPromptSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking part-prompt state in Redis', err);
    const expiresAt = partPromptSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

export async function markPartPromptSent(phone: string): Promise<void> {
  const key = `partPrompt:${phone}`;
  partPromptSessions.set(key, Date.now() + SESSION_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, '1');
  } catch (err) {
    logger.error('Error marking part-prompt state in Redis', err);
  }
}

/**
 * Tracks the "which of your vehicles is this for?" picker shown when a customer with
 * 2+ vehicles is about to be invited to ask for a part — awaits their numeric reply,
 * same shape/lifecycle as `savePendingOptions` above but a separate key since a search
 * can also have its own pending options open at a different point in the flow.
 */
const pendingVehicleChoiceCache = new Map<string, { id: number; make: string; model: string; year: string }[]>();

export async function savePendingVehicleChoice(
  phone: string,
  vehicles: { id: number; make: string; model: string; year: string }[]
): Promise<void> {
  const key = `vehicleChoice:${phone}`;
  pendingVehicleChoiceCache.set(key, vehicles);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(vehicles));
  } catch (err) {
    logger.error('Error saving pending vehicle choice to Redis', err);
  }
}

export async function getPendingVehicleChoice(phone: string): Promise<{ id: number; make: string; model: string; year: string }[] | null> {
  const key = `vehicleChoice:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return pendingVehicleChoiceCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending vehicle choice from Redis', err);
    return pendingVehicleChoiceCache.get(key) || null;
  }
}

export async function clearPendingVehicleChoice(phone: string): Promise<void> {
  const key = `vehicleChoice:${phone}`;
  pendingVehicleChoiceCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending vehicle choice from Redis', err);
  }
}

// Which vehicle applies to the customer's current "ask for a part" invitation, once
// resolved (either the only vehicle on file, or the customer's answer to the picker
// above). ai.service.ts reads this instead of guessing when there's more than one
// vehicle on file.
const chosenVehicleSessions = new Map<string, { id: number; expiresAt: number }>();

export async function saveChosenVehicle(phone: string, vehicleId: number): Promise<void> {
  const key = `chosenVehicle:${phone}`;
  chosenVehicleSessions.set(key, { id: vehicleId, expiresAt: Date.now() + SESSION_TTL * 1000 });

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, String(vehicleId));
  } catch (err) {
    logger.error('Error saving chosen vehicle to Redis', err);
  }
}

export async function getChosenVehicle(phone: string): Promise<number | null> {
  const key = `chosenVehicle:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const entry = chosenVehicleSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.id : null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? parseInt(data, 10) : null;
  } catch (err) {
    logger.error('Error fetching chosen vehicle from Redis', err);
    const entry = chosenVehicleSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.id : null;
  }
}

// Tracks "the customer was just shown the VIN/photo/manual vehicle-ID choice"
// (during onboarding, or via the 'add another vehicle' flow for a customer who
// already has one) — needed so a photo they send next is routed to
// processVehicleDocument, and a VIN/manual button tap to processVehicleIdOptionChoice,
// even once they already have a confirmed vehicle on file (needsVehicleId would
// otherwise be false and neither check would fire). 30-min TTL matches the
// manual-collection wizard's own window rather than the full 4h session.
const vehicleIdChoiceSessions = new Map<string, number>();

export async function markVehicleIdChoiceShown(phone: string): Promise<void> {
  const key = `vehicleIdChoice:${phone}`;
  vehicleIdChoiceSessions.set(key, Date.now() + VEHICLE_ID_CHOICE_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, VEHICLE_ID_CHOICE_TTL, '1');
  } catch (err) {
    logger.error('Error marking vehicle-ID choice shown in Redis', err);
  }
}

export async function wasVehicleIdChoiceShown(phone: string): Promise<boolean> {
  const key = `vehicleIdChoice:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = vehicleIdChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking vehicle-ID choice state in Redis', err);
    const expiresAt = vehicleIdChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

/**
 * Clears the vehicle-ID choice flag once identification concludes (vehicle
 * confirmed/rejected, or manual collection completes) — without this, the
 * flag only expired via its 30-min TTL, which let it linger stale after the
 * customer had already moved on (e.g. into a part search), a latent risk now
 * that whatsapp.controller.ts's stage 10 fallback also reads this flag.
 */
export async function clearVehicleIdChoiceShown(phone: string): Promise<void> {
  const key = `vehicleIdChoice:${phone}`;
  vehicleIdChoiceSessions.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error clearing vehicle-ID choice in Redis', err);
  }
}

/**
 * Tracks a pending "want me to notify you when this product is back in
 * stock?" offer awaiting the customer's yes/no reply. Uses a dedicated map
 * (not the options `memoryCache`) since a single offer object is a
 * different shape than the array-of-options it stores.
 */
const waitlistOfferCache = new Map<string, { productId: number; productName: string }>();

export async function savePendingWaitlistOffer(
  phone: string,
  offer: { productId: number; productName: string }
): Promise<void> {
  const key = `waitlist:${phone}`;
  waitlistOfferCache.set(key, offer);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(offer));
  } catch (err) {
    logger.error('Error saving pending waitlist offer to Redis', err);
  }
}

export async function getPendingWaitlistOffer(phone: string): Promise<{ productId: number; productName: string } | null> {
  const key = `waitlist:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return waitlistOfferCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending waitlist offer from Redis', err);
    return waitlistOfferCache.get(key) || null;
  }
}

export async function clearPendingWaitlistOffer(phone: string): Promise<void> {
  const key = `waitlist:${phone}`;
  waitlistOfferCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending waitlist offer from Redis', err);
  }
}

/**
 * Tracks a pending "your waitlisted product is back in stock — order now?"
 * offer awaiting the customer's yes/no reply. Kept separate from
 * waitlistOfferCache above even though the shape is identical — that one
 * means "yes, notify me later"; this one means "yes, order right now" — and
 * a customer could plausibly have both pending for different products.
 */
const restockOrderOfferCache = new Map<string, { productId: number; productName: string }>();

export async function savePendingRestockOrderOffer(
  phone: string,
  offer: { productId: number; productName: string }
): Promise<void> {
  const key = `restockOrder:${phone}`;
  restockOrderOfferCache.set(key, offer);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(offer));
  } catch (err) {
    logger.error('Error saving pending restock-order offer to Redis', err);
  }
}

export async function getPendingRestockOrderOffer(phone: string): Promise<{ productId: number; productName: string } | null> {
  const key = `restockOrder:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return restockOrderOfferCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending restock-order offer from Redis', err);
    return restockOrderOfferCache.get(key) || null;
  }
}

export async function clearPendingRestockOrderOffer(phone: string): Promise<void> {
  const key = `restockOrder:${phone}`;
  restockOrderOfferCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending restock-order offer from Redis', err);
  }
}

/**
 * Tracks a pending "want to add this service to your order?" offer awaiting
 * the customer's yes/no reply — same shape/lifecycle as
 * savePendingWaitlistOffer above, just a distinct offer payload/key since a
 * customer could in principle have both pending at slightly different points.
 * Carries the full selected product (not just its name) so the proforma can
 * be generated once the offer resolves, without a re-fetch.
 */
export interface PendingServiceOffer {
  orderNumber: string;
  product: Product;
  serviceName: string;
  servicePrice: number;
}

const serviceOfferCache = new Map<string, PendingServiceOffer>();

export async function savePendingServiceOffer(phone: string, offer: PendingServiceOffer): Promise<void> {
  const key = `serviceOffer:${phone}`;
  serviceOfferCache.set(key, offer);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(offer));
  } catch (err) {
    logger.error('Error saving pending service offer to Redis', err);
  }
}

export async function getPendingServiceOffer(phone: string): Promise<PendingServiceOffer | null> {
  const key = `serviceOffer:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return serviceOfferCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending service offer from Redis', err);
    return serviceOfferCache.get(key) || null;
  }
}

export async function clearPendingServiceOffer(phone: string): Promise<void> {
  const key = `serviceOffer:${phone}`;
  serviceOfferCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending service offer from Redis', err);
  }
}

/**
 * Tracks a pending "the admin marked this order's stock unavailable — want
 * alternatives or the waitlist?" offer awaiting the customer's yes/no reply.
 * Same shape/lifecycle as savePendingWaitlistOffer above.
 */
export interface PendingStockUnavailableOffer {
  orderNumber: string;
  productId: number;
  productName: string;
}

const stockUnavailableOfferCache = new Map<string, PendingStockUnavailableOffer>();

export async function savePendingStockUnavailableOffer(phone: string, offer: PendingStockUnavailableOffer): Promise<void> {
  const key = `stockUnavailable:${phone}`;
  stockUnavailableOfferCache.set(key, offer);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(offer));
  } catch (err) {
    logger.error('Error saving pending stock-unavailable offer to Redis', err);
  }
}

export async function getPendingStockUnavailableOffer(phone: string): Promise<PendingStockUnavailableOffer | null> {
  const key = `stockUnavailable:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return stockUnavailableOfferCache.get(key) || null;
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error fetching pending stock-unavailable offer from Redis', err);
    return stockUnavailableOfferCache.get(key) || null;
  }
}

export async function clearPendingStockUnavailableOffer(phone: string): Promise<void> {
  const key = `stockUnavailable:${phone}`;
  stockUnavailableOfferCache.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting pending stock-unavailable offer from Redis', err);
  }
}

// Tracks "the customer was just shown the VIN-already-registered choice"
// (Search for a part / Add different vehicle) — same shape/lifecycle as
// vehicleIdChoiceSessions above, 30-min TTL.
const vinDuplicateChoiceSessions = new Map<string, number>();

export async function markVinDuplicateChoiceShown(phone: string): Promise<void> {
  const key = `vinDuplicateChoice:${phone}`;
  vinDuplicateChoiceSessions.set(key, Date.now() + VEHICLE_ID_CHOICE_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, VEHICLE_ID_CHOICE_TTL, '1');
  } catch (err) {
    logger.error('Error marking VIN-duplicate choice shown in Redis', err);
  }
}

export async function wasVinDuplicateChoiceShown(phone: string): Promise<boolean> {
  const key = `vinDuplicateChoice:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = vinDuplicateChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking VIN-duplicate choice state in Redis', err);
    const expiresAt = vinDuplicateChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

export async function clearVinDuplicateChoice(phone: string): Promise<void> {
  const key = `vinDuplicateChoice:${phone}`;
  vinDuplicateChoiceSessions.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error clearing VIN-duplicate choice in Redis', err);
  }
}

// Tracks "the customer was just shown the document-unreadable retry/manual-entry
// choice" (processVehicleDocument's failure paths) — same shape/lifecycle as
// vehicleIdChoiceSessions above, 30-min TTL.
const documentRetryChoiceSessions = new Map<string, number>();

export async function markDocumentRetryChoiceShown(phone: string): Promise<void> {
  const key = `documentRetryChoice:${phone}`;
  documentRetryChoiceSessions.set(key, Date.now() + VEHICLE_ID_CHOICE_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, VEHICLE_ID_CHOICE_TTL, '1');
  } catch (err) {
    logger.error('Error marking document-retry choice shown in Redis', err);
  }
}

export async function wasDocumentRetryChoiceShown(phone: string): Promise<boolean> {
  const key = `documentRetryChoice:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = documentRetryChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking document-retry choice state in Redis', err);
    const expiresAt = documentRetryChoiceSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

export async function clearDocumentRetryChoice(phone: string): Promise<void> {
  const key = `documentRetryChoice:${phone}`;
  documentRetryChoiceSessions.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error clearing document-retry choice in Redis', err);
  }
}
