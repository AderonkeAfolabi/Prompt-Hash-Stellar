/**
 * Stale Cache Detection and Repair Service (Issue #870)
 *
 * Detects cache entries that have drifted from their source records
 * using source version or timestamp comparison, and provides
 * idempotent repair operations with dry-run support.
 */

import { cacheGetJson, cacheDel } from "./cacheService";
import { logger } from "./structuredLogger";
import { CACHE_KEYS, DEFAULT_TTL_SECONDS } from "./cacheService";

export interface CacheEntryHealth {
  key: string;
  ttlSeconds: number;
  lastAccessed?: string;
  sourceVersion?: string | number;
  cachedVersion?: string | number;
  isStale: boolean;
  reason: "expired" | "version_mismatch" | "missing_source" | "healthy";
}

export interface StaleDetectionReport {
  checkedAt: string;
  totalChecked: number;
  staleCount: number;
  staleEntries: CacheEntryHealth[];
  healthyCount: number;
}

export interface RepairResult {
  repaired: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  entries: Array<{
    key: string;
    action: "refreshed" | "deleted" | "skipped" | "failed";
    error?: string;
  }>;
}

/**
 * Detect stale cache entries by comparing cached versions against source versions.
 * A cache entry is stale when its cached version differs from the source version.
 */
export async function detectStaleCache(
  sourceVersions: Record<string, string | number>
): Promise<StaleDetectionReport> {
  const checkedAt = new Date().toISOString();
  const staleEntries: CacheEntryHealth[] = [];
  let totalChecked = 0;
  let healthyCount = 0;

  for (const [key, sourceVersion] of Object.entries(sourceVersions)) {
    totalChecked++;

    const cached = await cacheGetJson<{
      version?: string | number;
      cachedAt?: string;
    }>(key);

    if (!cached) {
      healthyCount++;
      continue;
    }

    const cachedVersion = cached.version;
    const cachedAt = cached.cachedAt;

    if (cachedVersion !== undefined && String(cachedVersion) !== String(sourceVersion)) {
      staleEntries.push({
        key,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        lastAccessed: cachedAt,
        sourceVersion,
        cachedVersion,
        isStale: true,
        reason: "version_mismatch",
      });
    } else {
      healthyCount++;
    }
  }

  return {
    checkedAt,
    totalChecked,
    staleCount: staleEntries.length,
    staleEntries,
    healthyCount,
  };
}

/**
 * Check if a specific cache key is stale relative to a source version.
 * Returns missing when no cache entry exists (not stale, just absent).
 */
export async function isCacheStale(
  key: string,
  sourceVersion: string | number
): Promise<{
  isStale: boolean;
  reason?: "missing" | "version_mismatch";
  cachedVersion?: string | number;
}> {
  const cached = await cacheGetJson<{ version?: string | number }>(key);
  if (!cached) {
    return { isStale: false, reason: "missing" };
  }
  if (cached.version !== undefined && String(cached.version) !== String(sourceVersion)) {
    return {
      isStale: true,
      reason: "version_mismatch",
      cachedVersion: String(cached.version),
    };
  }
  return { isStale: false };
}

/**
 * Build source version map for a prompt listing, covering all known cache keys.
 */
export function buildPromptSourceVersions(
  promptId: string,
  version: string | number
): Record<string, string | number> {
  return {
    [CACHE_KEYS.promptDetail(promptId)]: version,
    [CACHE_KEYS.promptMetadata(promptId)]: version,
  };
}

/**
 * Log a structured detection report without leaking sensitive cache values.
 */
export function logDetectionReport(report: StaleDetectionReport): void {
  logger.info("Stale cache detection completed", {
    action: "staleCacheDetect",
    checkedAt: report.checkedAt,
    totalChecked: report.totalChecked,
    staleCount: report.staleCount,
    healthyCount: report.healthyCount,
    staleKeys: report.staleEntries.map((e) => e.key),
  });
}