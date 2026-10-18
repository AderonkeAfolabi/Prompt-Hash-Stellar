import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectStaleCache,
  isCacheStale,
  buildPromptSourceVersions,
  type CacheEntryHealth,
} from "../services/staleCacheService";

vi.mock("../services/cacheService", () => ({
  cacheGetJson: vi.fn(),
  cacheDel: vi.fn(),
  CACHE_KEYS: {
    promptDetail: (id: string) => `prompts:detail:${id}`,
    promptMetadata: (id: string) => `prompts:metadata:${id}`,
  },
  DEFAULT_TTL_SECONDS: 60,
}));

import { cacheGetJson } from "../services/cacheService";

const mockCacheGetJson = cacheGetJson as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("detectStaleCache (Issue #870)", () => {
  it("detects stale entries when cached version differs from source", async () => {
    mockCacheGetJson.mockResolvedValue({ version: "1", cachedAt: "2026-01-01T00:00:00Z" });

    const sourceVersions = { "prompts:detail:abc": "2" };
    const report = await detectStaleCache(sourceVersions);

    expect(report.totalChecked).toBe(1);
    expect(report.staleCount).toBe(1);
    expect(report.healthyCount).toBe(0);
    expect(report.staleEntries[0]).toMatchObject({
      key: "prompts:detail:abc",
      isStale: true,
      reason: "version_mismatch",
      sourceVersion: "2",
      cachedVersion: "1",
    });
  });

  it("reports healthy entries when versions match", async () => {
    mockCacheGetJson.mockResolvedValue({ version: "2", cachedAt: "2026-01-01T00:00:00Z" });

    const sourceVersions = { "prompts:detail:abc": "2" };
    const report = await detectStaleCache(sourceVersions);

    expect(report.staleCount).toBe(0);
    expect(report.healthyCount).toBe(1);
  });

  it("treats missing cache as healthy (not stale)", async () => {
    mockCacheGetJson.mockResolvedValue(null);

    const sourceVersions = { "prompts:detail:abc": "2" };
    const report = await detectStaleCache(sourceVersions);

    expect(report.staleCount).toBe(0);
    expect(report.healthyCount).toBe(1);
  });

  it("handles multiple keys with mixed stale/healthy states", async () => {
    mockCacheGetJson
      .mockResolvedValueOnce({ version: "1" })
      .mockResolvedValueOnce({ version: "2" });

    const sourceVersions = {
      "prompts:detail:abc": "2",
      "prompts:detail:def": "2",
    };
    const report = await detectStaleCache(sourceVersions);

    expect(report.totalChecked).toBe(2);
    expect(report.staleCount).toBe(1);
    expect(report.healthyCount).toBe(1);
  });

  it("returns empty report when no source versions provided", async () => {
    const report = await detectStaleCache({});
    expect(report.totalChecked).toBe(0);
    expect(report.staleCount).toBe(0);
    expect(report.staleEntries).toEqual([]);
  });
});

describe("isCacheStale (Issue #870)", () => {
  it("returns stale when versions mismatch", async () => {
    mockCacheGetJson.mockResolvedValue({ version: "1" });
    const result = await isCacheStale("prompts:detail:abc", "2");
    expect(result.isStale).toBe(true);
    expect(result.reason).toBe("version_mismatch");
    expect(result.cachedVersion).toBe("1");
  });

  it("returns not stale when versions match", async () => {
    mockCacheGetJson.mockResolvedValue({ version: "2" });
    const result = await isCacheStale("prompts:detail:abc", "2");
    expect(result.isStale).toBe(false);
  });

  it("returns missing when no cache entry exists", async () => {
    mockCacheGetJson.mockResolvedValue(null);
    const result = await isCacheStale("prompts:detail:abc", "2");
    expect(result.isStale).toBe(false);
    expect(result.reason).toBe("missing");
  });
});

describe("buildPromptSourceVersions (Issue #870)", () => {
  it("builds source versions for all prompt cache keys", () => {
    const versions = buildPromptSourceVersions("prompt-123", "42");
    expect(versions).toEqual({
      "prompts:detail:prompt-123": "42",
      "prompts:metadata:prompt-123": "42",
    });
  });
});