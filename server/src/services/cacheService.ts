import { createClient, type RedisClientType } from "redis";
import { logger } from "./structuredLogger";
import { BoundedCache, type CacheLookup } from "./boundedCache";

let client: RedisClientType | null = null;
let connectingPromise: Promise<RedisClientType | null> | null = null;

const configuredMaxEntries = Number.parseInt(
  process.env.LOCAL_CACHE_MAX_ENTRIES ?? "500",
  10,
);
const localCache = new BoundedCache<string>({
  maxEntries:
    Number.isSafeInteger(configuredMaxEntries) && configuredMaxEntries > 0
      ? configuredMaxEntries
      : 500,
  defaultTtlMs: 60_000,
  defaultStaleMs: 48_000,
});

// Authorization decisions fail closed when Redis is unavailable. A local copy
// could miss an invalidation published by another replica and must not grant access.
function canUseLocalFallback(key: string): boolean {
  return !key.startsWith("entitlement:");
}

export async function getClient(): Promise<RedisClientType | null> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  if (client && client.isOpen) return client;

  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    try {
      const c = createClient({ url: redisUrl }) as RedisClientType;
      c.on("error", (err) => {
        logger.error("Redis client error", {
          action: "cacheService",
          error: err,
        });
      });
      c.on("reconnecting", () => {
        logger.info("Redis reconnecting", { action: "cacheService" });
      });
      await c.connect();
      client = c;
      return client;
    } catch (err) {
      logger.error("Failed to connect to Redis", {
        action: "cacheService",
        error: err,
      });
      client = null;
      return null;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

export const DEFAULT_TTL_SECONDS = 60; // 1 minute
export const METADATA_TTL_SECONDS = 300; // 5 minutes
export const CATEGORY_TTL_SECONDS = 600; // 10 minutes

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const c = await getClient();
    if (!c)
      return canUseLocalFallback(key) ? (localCache.get(key) ?? null) : null;
    const value = await c.get(key);
    if (value !== null && canUseLocalFallback(key)) {
      localCache.set(key, value);
    }
    return value;
  } catch (err) {
    logger.debug("Cache get failed", { action: "cacheGet", key, error: err });
    return canUseLocalFallback(key) ? (localCache.get(key) ?? null) : null;
  }
}

/** Exposes stale state for metrics/debugging without ever serving stale data. */
export function inspectLocalCache(key: string): CacheLookup<string> {
  return localCache.inspect(key);
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await cacheGet(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.debug("Cache get JSON failed or parse error", {
      action: "cacheGetJson",
      key,
      error: err,
    });
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    if (canUseLocalFallback(key)) {
      const ttlMs =
        Number.isFinite(ttlSeconds) && ttlSeconds > 0
          ? ttlSeconds * 1_000
          : DEFAULT_TTL_SECONDS * 1_000;
      localCache.set(key, value, ttlMs, ttlMs * 0.8);
    }
    const c = await getClient();
    if (!c) return;
    await c.set(key, value, { EX: ttlSeconds });
  } catch (err) {
    logger.debug("Cache set failed", { action: "cacheSet", key, error: err });
  }
}

export async function cacheSetJson<T>(
  key: string,
  value: T,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    await cacheSet(key, serialized, ttlSeconds);
  } catch (err) {
    logger.debug("Cache set JSON serialization failed", {
      action: "cacheSetJson",
      key,
      error: err,
    });
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  try {
    if (!keys || keys.length === 0) return;
    for (const key of keys) localCache.invalidate(key);
    const c = await getClient();
    if (!c) return;
    await c.del(keys);
  } catch (err) {
    logger.debug("Cache delete failed", {
      action: "cacheDel",
      keys,
      error: err,
    });
  }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  try {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const matcher = new RegExp(`^${escaped}$`);
    localCache.invalidateWhere((key) => matcher.test(key));
    const c = await getClient();
    if (!c) return;
    const keys = await c.keys(pattern);
    if (keys.length > 0) {
      await c.del(keys);
    }
  } catch (err) {
    logger.debug("Cache delete pattern failed", {
      action: "cacheDelPattern",
      pattern,
      error: err,
    });
  }
}

export const CACHE_KEYS = {
  promptList: (query: string) => `prompts:list:${query}`,
  allPrompts: (query: string) => `prompts:all:${query}`,
  promptDetail: (id: string) => `prompts:detail:${id}`,
  promptMetadata: (id: string) => `prompts:metadata:${id}`,
  categories: () => "prompts:categories",
  featuredPrompts: (limit: number) => `prompts:featured:${limit}`,
  searchSuggestions: (query: string) => `search:suggestions:${query}`,
  searchResults: (filterKey: string) => `search:signals:${filterKey}`,
  entitlementDecision: (promptId: string, walletAddress: string) =>
    `entitlement:${promptId}:${walletAddress}`,
  entitlementDecisionPattern: (promptId: string) => `entitlement:${promptId}:*`,
};

/**
 * Invalidates all read and indexing caches related to a prompt listing.
 * Cleans individual prompt detail/metadata, global/filtered listings,
 * and entitlement decision records.
 */
export async function invalidatePromptCaches(promptId: string): Promise<void> {
  try {
    await Promise.all([
      cacheDel(
        CACHE_KEYS.promptDetail(promptId),
        CACHE_KEYS.promptMetadata(promptId),
      ),
      cacheDelPattern("prompts:list:*"),
      cacheDelPattern("prompts:all:*"),
      cacheDelPattern("prompts:featured:*"),
      cacheDelPattern("search:signals:*"),
      cacheDelPattern("search:suggestions:*"),
      cacheDel(CACHE_KEYS.categories()),
      cacheDelPattern(CACHE_KEYS.entitlementDecisionPattern(promptId)),
    ]);
  } catch (err) {
    logger.error("Failed to invalidate prompt caches", {
      action: "invalidatePromptCaches",
      promptId,
      error: err,
    });
  }
}
