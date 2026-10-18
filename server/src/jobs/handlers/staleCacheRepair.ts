/**
 * stale_cache_repair — idempotent repair of stale cache entries.
 *
 * Compares cached versions against source versions and deletes stale
 * entries so they are repopulated from source on next read. Safe to rerun.
 */
import type { JobRecordDTO } from "../types";
import { detectStaleCache, buildPromptSourceVersions } from "../services/staleCacheService";
import { cacheDel, CACHE_KEYS } from "../services/cacheService";
import { logger } from "../services/structuredLogger";

export interface StaleCacheRepairPayload {
  version: 1;
  dryRun?: boolean;
  promptId?: string;
  sourceVersion?: string | number;
  maxEntries?: number;
}

export async function handleStaleCacheRepair(job: JobRecordDTO): Promise<void> {
  const {
    dryRun = false,
    promptId,
    sourceVersion,
    maxEntries = 100,
  } = job.payload as StaleCacheRepairPayload;

  const sourceVersions: Record<string, string | number> = {};
  if (promptId && sourceVersion !== undefined) {
    Object.assign(sourceVersions, buildPromptSourceVersions(promptId, sourceVersion));
  }

  const report = await detectStaleCache(sourceVersions);

  const entriesToRepair = report.staleEntries.slice(0, maxEntries);
  const results: Array<{ key: string; action: string; error?: string }> = [];
  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entriesToRepair) {
    try {
      if (dryRun) {
        results.push({ key: entry.key, action: "skipped" });
        skipped++;
        continue;
      }

      await cacheDel(entry.key);
      results.push({ key: entry.key, action: "deleted" });
      repaired++;
    } catch (err: any) {
      logger.error("Stale cache repair failed", {
        action: "staleCacheRepair",
        key: entry.key,
        error: err.message,
      });
      results.push({ key: entry.key, action: "failed", error: err.message });
      failed++;
    }
  }

  logger.info("Stale cache repair completed", {
    action: "staleCacheRepair",
    dryRun,
    promptId,
    repaired,
    skipped,
    failed,
    totalStale: report.staleCount,
    entries: results,
  });
}