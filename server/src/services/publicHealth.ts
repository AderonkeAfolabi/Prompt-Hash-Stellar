/**
 * Dependency-aware public health (#1027).
 *
 * The legacy `/health` route always answers `"ok"`, even when MongoDB is
 * unreachable, so load balancers and status pages cannot tell a healthy
 * replica from a broken one. This module evaluates each dependency with a
 * timeout and a bounded retry, folds the results into one status, and
 * publishes a redacted view safe for unauthenticated callers.
 *
 * Status rules:
 *   down     — at least one CRITICAL dependency is down (HTTP 503)
 *   degraded — a non-critical dependency is down, or any dependency is slow
 *              or partially available (HTTP 200: the API still serves)
 *   ok       — everything is up
 *
 * Results are cached for a short TTL and evaluated single-flight, so a burst
 * of health checks (or an attacker hammering the public endpoint) produces at
 * most one probe round per TTL against the dependencies.
 *
 * See docs/operations/public-health-endpoint.md.
 */

import mongoose from "mongoose";
import { IndexerState } from "../models/IndexerState";
import { toPublicReason, type PublicReasonCode } from "./publicStatus";

export type DependencyStatus = "up" | "degraded" | "down";
export type OverallHealth = "ok" | "degraded" | "down";

export interface CheckResult {
  status: DependencyStatus;
  /** Internal detail (raw error text, hostnames). Never published. */
  detail?: string;
  /** Public reason code; derived from `detail` when omitted. */
  reason?: PublicReasonCode;
  observed?: Record<string, unknown>;
}

export interface HealthCheckDefinition {
  name: string;
  /** A critical dependency being down makes the whole service `down`. */
  critical: boolean;
  run: () => Promise<CheckResult>;
}

export interface CheckOutcome {
  name: string;
  critical: boolean;
  status: DependencyStatus;
  latencyMs: number;
  attempts: number;
  detail?: string;
  reason?: PublicReasonCode;
  observed?: Record<string, unknown>;
  checkedAt: string;
}

export interface HealthReport {
  status: OverallHealth;
  checkedAt: string;
  dependencies: CheckOutcome[];
}

export interface PublicDependency {
  name: string;
  status: DependencyStatus;
  critical: boolean;
  latencyMs: number;
  reason?: PublicReasonCode;
}

export interface PublicHealth {
  status: OverallHealth;
  checkedAt: string;
  cached: boolean;
  dependencies: PublicDependency[];
}

export interface RunCheckOptions {
  timeoutMs: number;
  /** Extra attempts after the first one fails. */
  retries: number;
  retryDelayMs: number;
}

export const DEFAULT_RUN_OPTIONS: RunCheckOptions = {
  timeoutMs: 2_000,
  retries: 1,
  retryDelayMs: 150,
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one check with a timeout. A `down` result or a thrown error is retried
 * up to `retries` times so a single dropped packet does not flip the
 * service to `down`; `degraded` is a real answer and is not retried.
 */
export async function runCheck(
  check: HealthCheckDefinition,
  options: RunCheckOptions = DEFAULT_RUN_OPTIONS,
): Promise<CheckOutcome> {
  const start = Date.now();
  let attempts = 0;
  let result: CheckResult = { status: "down", detail: "not run" };

  while (attempts <= options.retries) {
    attempts += 1;
    try {
      result = await withTimeout(check.run(), options.timeoutMs);
    } catch (err) {
      result = { status: "down", detail: err instanceof Error ? err.message : String(err) };
    }
    if (result.status !== "down" || attempts > options.retries) break;
    await delay(options.retryDelayMs);
  }

  return {
    name: check.name,
    critical: check.critical,
    status: result.status,
    latencyMs: Date.now() - start,
    attempts,
    detail: result.detail,
    reason: result.reason,
    observed: result.observed,
    checkedAt: new Date().toISOString(),
  };
}

export function aggregateHealth(outcomes: CheckOutcome[]): OverallHealth {
  if (outcomes.some((o) => o.critical && o.status === "down")) return "down";
  if (outcomes.some((o) => o.status !== "up")) return "degraded";
  return "ok";
}

export async function evaluateHealth(
  checks: HealthCheckDefinition[],
  options: RunCheckOptions = DEFAULT_RUN_OPTIONS,
): Promise<HealthReport> {
  const dependencies = await Promise.all(checks.map((check) => runCheck(check, options)));
  return {
    status: aggregateHealth(dependencies),
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}

/** Strip everything an unauthenticated caller must not see. */
export function toPublicHealth(report: HealthReport, cached: boolean): PublicHealth {
  return {
    status: report.status,
    checkedAt: report.checkedAt,
    cached,
    dependencies: report.dependencies.map((dep) => {
      const base: PublicDependency = {
        name: dep.name,
        status: dep.status,
        critical: dep.critical,
        latencyMs: dep.latencyMs,
      };
      if (dep.status === "up") return base;
      return { ...base, reason: dep.reason ?? toPublicReason(dep.detail ?? "") };
    }),
  };
}

export function httpStatusFor(status: OverallHealth): number {
  return status === "down" ? 503 : 200;
}

export interface HealthMonitorOptions {
  checks: () => HealthCheckDefinition[];
  cacheTtlMs: number;
  runOptions?: RunCheckOptions;
  now?: () => number;
}

/**
 * Caches the last report for `cacheTtlMs` and collapses concurrent
 * evaluations into one in-flight probe round.
 */
export function createHealthMonitor(options: HealthMonitorOptions) {
  const now = options.now ?? Date.now;
  let last: { report: HealthReport; at: number } | null = null;
  let inFlight: Promise<HealthReport> | null = null;

  async function evaluate(force = false): Promise<{ report: HealthReport; cached: boolean }> {
    if (!force && last && now() - last.at < options.cacheTtlMs) {
      return { report: last.report, cached: true };
    }
    if (!inFlight) {
      inFlight = evaluateHealth(options.checks(), options.runOptions)
        .then((report) => {
          last = { report, at: now() };
          return report;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return { report: await inFlight, cached: false };
  }

  return {
    evaluate,
    reset() {
      last = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Production checks
// ---------------------------------------------------------------------------

const INDEXER_DEGRADED_AFTER_MS = Number(process.env.HEALTH_INDEXER_DEGRADED_AFTER_MS ?? 60_000);
const INDEXER_DOWN_AFTER_MS = Number(process.env.HEALTH_INDEXER_DOWN_AFTER_MS ?? 600_000);

export const databaseCheck: HealthCheckDefinition = {
  name: "database",
  critical: true,
  run: async () => {
    const connection = mongoose.connection;
    if (connection.readyState !== 1 || !connection.db) {
      return { status: "down", detail: `mongoose readyState=${connection.readyState}`, reason: "unreachable" };
    }
    await connection.db.admin().ping();
    return { status: "up" };
  },
};

/**
 * The indexer renews its lease (and so bumps `updatedAt`) every poll, so the
 * checkpoint's age is a liveness signal even when no new events arrive. A
 * stale indexer serves stale marketplace data but does not stop the API, so
 * it is non-critical.
 */
export function indexerCheck(nowMs: () => number = Date.now): HealthCheckDefinition {
  return {
    name: "indexer",
    critical: false,
    run: async () => {
      const state: any = await IndexerState.findOne({ key: "prompt_hash_contract" }).lean();
      if (!state?.updatedAt) {
        return { status: "degraded", detail: "no indexer checkpoint", reason: "unhealthy" };
      }
      const ageMs = nowMs() - new Date(state.updatedAt).getTime();
      const observed = { lastIndexedLedger: state.lastIndexedLedger ?? 0, checkpointAgeMs: ageMs };
      if (ageMs > INDEXER_DOWN_AFTER_MS) {
        return { status: "down", detail: `checkpoint stale for ${ageMs}ms`, reason: "unhealthy", observed };
      }
      if (ageMs > INDEXER_DEGRADED_AFTER_MS) {
        return { status: "degraded", detail: `checkpoint lagging ${ageMs}ms`, reason: "unhealthy", observed };
      }
      return { status: "up", observed };
    },
  };
}

export function stellarRpcCheck(
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): HealthCheckDefinition {
  return {
    name: "stellar_rpc",
    critical: false,
    run: async () => {
      const resp = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      if (!resp.ok) return { status: "down", detail: `HTTP ${resp.status}` };
      const body = (await resp.json()) as { result?: { status?: string; latestLedger?: number } };
      if (body?.result?.status !== "healthy") {
        return {
          status: "degraded",
          detail: `rpc reported ${body?.result?.status ?? "unknown"}`,
          reason: "unhealthy",
        };
      }
      return { status: "up", observed: { latestLedger: body.result.latestLedger } };
    },
  };
}

export function defaultHealthChecks(): HealthCheckDefinition[] {
  const checks = [databaseCheck, indexerCheck()];
  const rpcUrl = process.env.STELLAR_RPC_URL || process.env.PUBLIC_STELLAR_RPC_URL;
  if (rpcUrl) checks.push(stellarRpcCheck(rpcUrl));
  return checks;
}

export const healthMonitor = createHealthMonitor({
  checks: defaultHealthChecks,
  cacheTtlMs: Number(process.env.HEALTH_CACHE_TTL_MS ?? 10_000),
});
