import { createClient } from 'redis';
import { createHash } from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';
import { Product } from '../models/product.model.js';

let redisClient: any = null;
let useMemoryFallback = false;
const memoryCache = new Map<string, any[]>();

const SESSION_TTL = 60 * 60 * 4; // 4 hours in seconds
// Was 30 minutes ("matches the manual-collection wizard's own window") — but that
// reasoning conflated two different things: the wizard's own 30-min abandonment
// window (getActiveManualCollection in vehicle.model.ts, unaffected by this constant)
// only starts once a customer is actively mid-wizard, answering make/model/year in
// quick succession. This constant instead governs "how long do we remember that a
// choice/retry prompt was shown at all" — e.g. a customer who taps "Try again" 48
// minutes after receiving the prompt (entirely plausible — they had to go find their
// document and take a clearer photo) was falling through with no handler and landing
// on an unrelated stale order's fallback. Every other pending-choice/offer flag in
// this file already uses the full SESSION_TTL; these three should too.
const VEHICLE_ID_CHOICE_TTL = SESSION_TTL;

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

// Tracks "the customer was just shown the vehicle Sim/Não confirm buttons"
// (right after a VIN decode or document scan succeeds) — same shape/lifecycle
// as vehicleIdChoiceSessions above. Without this, processVehicleConfirmation
// had no way to tell "no vehicle is actually pending confirmation" apart from
// "the customer's reply just didn't match sim/não", so it could never safely
// re-ask on a mismatch without risking hijacking unrelated messages.
const vehicleConfirmSessions = new Map<string, number>();

export async function markVehicleConfirmShown(phone: string): Promise<void> {
  const key = `vehicleConfirm:${phone}`;
  vehicleConfirmSessions.set(key, Date.now() + VEHICLE_ID_CHOICE_TTL * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, VEHICLE_ID_CHOICE_TTL, '1');
  } catch (err) {
    logger.error('Error marking vehicle-confirm choice shown in Redis', err);
  }
}

export async function wasVehicleConfirmShown(phone: string): Promise<boolean> {
  const key = `vehicleConfirm:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = vehicleConfirmSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking vehicle-confirm choice state in Redis', err);
    const expiresAt = vehicleConfirmSessions.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

export async function clearVehicleConfirmShown(phone: string): Promise<void> {
  const key = `vehicleConfirm:${phone}`;
  vehicleConfirmSessions.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error clearing vehicle-confirm choice in Redis', err);
  }
}

// Tracks "the customer was just shown the VIN-decode-failed retry/manual-entry
// choice" (processVIN's NHTSA lookup came back empty) — stores the attempted
// VIN (not just '1' like the boolean flags above) so it can still be threaded
// into startManualCollection's attempted_vin column if the customer picks
// manual, exactly like the old auto-fallback used to do unconditionally.
const vinDecodeFailedSessions = new Map<string, { vin: string; expiresAt: number }>();

export async function markVinDecodeFailedShown(phone: string, attemptedVin: string): Promise<void> {
  const key = `vinDecodeFailed:${phone}`;
  vinDecodeFailedSessions.set(key, { vin: attemptedVin, expiresAt: Date.now() + VEHICLE_ID_CHOICE_TTL * 1000 });

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, VEHICLE_ID_CHOICE_TTL, attemptedVin);
  } catch (err) {
    logger.error('Error marking VIN-decode-failed choice shown in Redis', err);
  }
}

export async function wasVinDecodeFailedShown(phone: string): Promise<boolean> {
  const key = `vinDecodeFailed:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const entry = vinDecodeFailedSessions.get(key);
    return !!entry && entry.expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking VIN-decode-failed choice state in Redis', err);
    const entry = vinDecodeFailedSessions.get(key);
    return !!entry && entry.expiresAt >= Date.now();
  }
}

// Retrieves the attempted VIN stored by markVinDecodeFailedShown, for
// processVinDecodeFailedChoice to thread into startManualCollection if the
// customer picks manual entry. Returns null when nothing's pending (distinct
// from wasVinDecodeFailedShown only in that callers here already know the
// flag is set — this is the value-fetching counterpart, not another gate).
export async function getVinDecodeFailedVin(phone: string): Promise<string | null> {
  const key = `vinDecodeFailed:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const entry = vinDecodeFailedSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.vin : null;
  }

  try {
    const data = await redisClient.get(key);
    return data ?? null;
  } catch (err) {
    logger.error('Error fetching VIN-decode-failed VIN from Redis', err);
    const entry = vinDecodeFailedSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.vin : null;
  }
}

export async function clearVinDecodeFailedChoice(phone: string): Promise<void> {
  const key = `vinDecodeFailed:${phone}`;
  vinDecodeFailedSessions.delete(key);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error clearing VIN-decode-failed choice in Redis', err);
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

/**
 * Tracks the customer's most recently detected conversation language —
 * refreshed on every inbound message whose text carries a recognizable PT/EN
 * signal (see detectMessageLocale in utils/greeting.ts), so a customer who
 * switches language mid-conversation gets answered in whatever they just
 * typed rather than a locale frozen at first contact. Deliberately
 * session-scoped (same SESSION_TTL as everything else here) instead of
 * durable — this used to be persisted forever on customers.locale, which
 * meant it was detected once and never re-evaluated; see resolveLocale in
 * customer.service.ts, the sole reader of this.
 */
const localeSessions = new Map<string, { locale: 'pt' | 'en'; expiresAt: number }>();

export async function saveLocale(phone: string, locale: 'pt' | 'en'): Promise<void> {
  const key = `locale:${phone}`;
  localeSessions.set(key, { locale, expiresAt: Date.now() + SESSION_TTL * 1000 });

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, locale);
  } catch (err) {
    logger.error('Error saving locale to Redis', err);
  }
}

export async function getLocale(phone: string): Promise<'pt' | 'en' | null> {
  const key = `locale:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    const entry = localeSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.locale : null;
  }

  try {
    const data = await redisClient.get(key);
    return data === 'pt' || data === 'en' ? data : null;
  } catch (err) {
    logger.error('Error fetching locale from Redis', err);
    const entry = localeSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.locale : null;
  }
}

/**
 * Generic per-phone string slot, backing the two conversation-context values
 * the humanization layer reads (see humanize.service.ts). Both are stored here
 * rather than threaded as parameters through the ~45 send call sites: every
 * sender already has the phone number in hand, so a session lookup keeps the
 * migration to reply.service.ts a one-line import change per file.
 */
const stringSessions = new Map<string, { value: string; expiresAt: number }>();

async function saveString(key: string, value: string): Promise<void> {
  stringSessions.set(key, { value, expiresAt: Date.now() + SESSION_TTL * 1000 });

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, SESSION_TTL, value);
  } catch (err) {
    logger.error(`Error saving ${key} to Redis`, err);
  }
}

async function getString(key: string): Promise<string | null> {
  const readMemory = () => {
    const entry = stringSessions.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.value : null;
  };

  if (useMemoryFallback || !redisClient?.isOpen) {
    return readMemory();
  }

  try {
    return (await redisClient.get(key)) ?? null;
  } catch (err) {
    logger.error(`Error fetching ${key} from Redis`, err);
    return readMemory();
  }
}

/**
 * The customer's most recent inbound message text. Written once per message in
 * processMessageFlow, read by the humanization layer so a rewrite can react to
 * what the customer actually said rather than only to the canned string.
 */
export async function saveLastMessage(phone: string, text: string): Promise<void> {
  return saveString(`lastmsg:${phone}`, text);
}

export async function getLastMessage(phone: string): Promise<string | null> {
  return getString(`lastmsg:${phone}`);
}

/**
 * The customer's first name, cached at the get-or-create step so a contextual
 * rewrite doesn't cost a DB round-trip on every send.
 */
export async function saveCustomerName(phone: string, name: string): Promise<void> {
  return saveString(`custname:${phone}`, name);
}

export async function getCustomerName(phone: string): Promise<string | null> {
  return getString(`custname:${phone}`);
}

/**
 * The Meta message id (wamid) of the last interactive (button/list) message
 * actually sent to this phone. WhatsApp never disables an old button/list
 * message client-side, so a customer can tap one from earlier in the
 * conversation at any time — comparing an inbound reply's `context.id`
 * against this value is how whatsapp.controller.ts tells a live answer apart
 * from a stale tap on an already-superseded question. Written by every
 * customer-facing interactive send (reply.service.ts's sendReplyButtons/
 * sendReplyList, plus the handful of call sites that intentionally bypass it)
 * — never by admin-facing sends, which can have several valid prompts live
 * at once and aren't part of this single-threaded guard.
 */
export async function saveActivePromptId(phone: string, messageId?: string | null): Promise<void> {
  if (!messageId) return;
  return saveString(`activePrompt:${phone}`, messageId);
}

export async function getActivePromptId(phone: string): Promise<string | null> {
  return getString(`activePrompt:${phone}`);
}

/**
 * Content-addressed cache of humanized message bodies. Keyed by a hash of the
 * source text (plus locale and, for contextual rewrites, the context), never by
 * phone — so the fixed prompts every customer sees cost exactly one Anthropic
 * call across the system's lifetime. TTL is deliberately longer than
 * SESSION_TTL: these entries aren't tied to any one conversation.
 */
const HUMANIZE_CACHE_TTL = 60 * 60 * 24; // 24 hours
const humanizeCache = new Map<string, { value: string; expiresAt: number }>();

export async function getHumanized(key: string): Promise<string | null> {
  const readMemory = () => {
    const entry = humanizeCache.get(key);
    return entry && entry.expiresAt >= Date.now() ? entry.value : null;
  };

  if (useMemoryFallback || !redisClient?.isOpen) {
    return readMemory();
  }

  try {
    return (await redisClient.get(key)) ?? null;
  } catch (err) {
    logger.error('Error fetching humanized text from Redis', err);
    return readMemory();
  }
}

export async function saveHumanized(key: string, value: string): Promise<void> {
  humanizeCache.set(key, { value, expiresAt: Date.now() + HUMANIZE_CACHE_TTL * 1000 });

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, HUMANIZE_CACHE_TTL, value);
  } catch (err) {
    logger.error('Error saving humanized text to Redis', err);
  }
}

/**
 * Server-side admin token blacklist. This JWT setup is otherwise fully
 * stateless (see adminAuth.service.ts) — an access/refresh token stays valid
 * until its own expiry regardless of anything happening server-side. Logging
 * out (POST /admin/logout, authMiddleware.ts) needs the token to actually stop
 * working immediately rather than silently remain valid until it naturally
 * expires, so the exact token is recorded here as revoked, TTL'd to exactly
 * its own remaining lifetime — never longer, since there's no reason to
 * remember a token past the point it would've stopped working anyway.
 * Keyed by a hash of the token rather than the raw string, same reasoning as
 * humanize.service.ts's cacheKey: no reason to let a live bearer token sit
 * around as a plain Redis key/value.
 */
const revokedTokens = new Map<string, number>();

function revokedTokenKey(token: string): string {
  return `revokedToken:${createHash('sha1').update(token).digest('hex')}`;
}

export async function revokeToken(token: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return; // already past its own expiry — nothing to blacklist
  const key = revokedTokenKey(token);
  revokedTokens.set(key, Date.now() + ttlSeconds * 1000);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.setEx(key, ttlSeconds, '1');
  } catch (err) {
    logger.error('Error revoking token in Redis', err);
  }
}

export async function isTokenRevoked(token: string): Promise<boolean> {
  const key = revokedTokenKey(token);
  if (useMemoryFallback || !redisClient?.isOpen) {
    const expiresAt = revokedTokens.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    logger.error('Error checking token revocation in Redis', err);
    const expiresAt = revokedTokens.get(key);
    return !!expiresAt && expiresAt >= Date.now();
  }
}

