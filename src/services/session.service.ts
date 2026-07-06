import { createClient } from 'redis';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';

let redisClient: any = null;
let useMemoryFallback = false;
const memoryCache = new Map<string, any[]>();

const SESSION_TTL = 60 * 60 * 4; // 4 hours in seconds

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

export async function getHistory(phone: string): Promise<any[]> {
  const key = `session:${phone}`;
  if (useMemoryFallback || !redisClient?.isOpen) {
    return memoryCache.get(key) || [];
  }

  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    logger.error('Error fetching session history from Redis', err);
    return memoryCache.get(key) || [];
  }
}

export async function saveHistory(phone: string, history: any[]): Promise<void> {
  const key = `session:${phone}`;
  const trimmedHistory = history.slice(-20);

  if (useMemoryFallback || !redisClient?.isOpen) {
    memoryCache.set(key, trimmedHistory);
    return;
  }

  try {
    // Keep local cache synced in case of sudden Redis dropouts
    memoryCache.set(key, trimmedHistory);
    await redisClient.setEx(key, SESSION_TTL, JSON.stringify(trimmedHistory));
  } catch (err) {
    logger.error('Error saving session history to Redis', err);
  }
}

export async function clearSession(phone: string): Promise<void> {
  const key = `session:${phone}`;
  memoryCache.delete(key);
  await clearPendingOptions(phone);
  await clearPendingWaitlistOffer(phone);

  if (useMemoryFallback || !redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    logger.error('Error deleting session from Redis', err);
  }
}

/**
 * Persists search result options awaiting the customer's numeric choice.
 * Stored under a dedicated key — custom properties on the history array
 * do not survive JSON serialization or the rolling-window slice.
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

// Tracks "have we heard from this number in the last 4h" independently of the AI
// conversation transcript above — a customer stuck in registration or mid-payment
// never touches getHistory/saveHistory, so that array can't be used as a session
// boundary. This is a plain presence marker, touched on every incoming message.
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
