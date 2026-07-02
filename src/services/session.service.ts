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
