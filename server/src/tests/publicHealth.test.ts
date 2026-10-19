import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dependency-aware public health endpoint (#1027).
 *
 * The aggregation, retry and caching logic is exercised with injected checks;
 * the HTTP surface runs the real router on an ephemeral port. Only
 * `requireAdminScope` is stubbed (header-driven) — HMAC token handling is
 * covered by adminAuth.test.ts.
 */

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const header = String(req.headers["x-test-admin"] ?? "");
    if (!header.split(",").includes(scope)) {
      res.status(401).json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    next();
  },
}));

import {
  aggregateHealth,
  createHealthMonitor,
  indexerCheck,
  runCheck,
  stellarRpcCheck,
  toPublicHealth,
  type CheckResult,
  type HealthCheckDefinition,
} from "../services/publicHealth";
import { createHealthRouter } from "../routes/healthRoutes";
import { IndexerState } from "../models/IndexerState";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";
import { resetRealMongo, setupRealMongo, teardownRealMongo } from "./helpers/realMongo";

const FAST = { timeoutMs: 50, retries: 1, retryDelayMs: 1 };

function check(name: string, critical: boolean, ...results: Array<CheckResult | Error>) {
  const run = vi.fn(async () => {
    const next = results.length > 1 ? results.shift()! : results[0];
    if (next instanceof Error) throw next;
    return next;
  });
  return { name, critical, run } satisfies HealthCheckDefinition;
}

describe("runCheck", () => {
  it("retries a failed attempt once and reports the recovery", async () => {
    const flaky = check("database", true, new Error("ECONNRESET"), { status: "up" });
    const outcome = await runCheck(flaky, FAST);
    expect(outcome).toMatchObject({ status: "up", attempts: 2 });
  });

  it("gives up after the retry budget and keeps the last error", async () => {
    const dead = check("database", true, new Error("ECONNREFUSED 10.0.0.5:27017"));
    const outcome = await runCheck(dead, FAST);
    expect(outcome).toMatchObject({ status: "down", attempts: 2 });
    expect(outcome.detail).toContain("ECONNREFUSED");
  });

  it("turns a hung dependency into a timeout instead of hanging the endpoint", async () => {
    const hung: HealthCheckDefinition = {
      name: "stellar_rpc",
      critical: false,
      run: () => new Promise(() => {}),
    };
    const outcome = await runCheck(hung, { ...FAST, retries: 0 });
    expect(outcome.status).toBe("down");
    expect(outcome.detail).toMatch(/timed out/);
  });

  it("does not retry a degraded answer", async () => {
    const slow = check("indexer", false, { status: "degraded", reason: "unhealthy" });
    const outcome = await runCheck(slow, FAST);
    expect(outcome.attempts).toBe(1);
    expect(slow.run).toHaveBeenCalledTimes(1);
  });
});

describe("aggregateHealth", () => {
  const outcome = (critical: boolean, status: "up" | "degraded" | "down") => ({
    name: "x",
    critical,
    status,
    latencyMs: 1,
    attempts: 1,
    checkedAt: "",
  });

  it("is down only when a critical dependency is down", () => {
    expect(aggregateHealth([outcome(true, "down"), outcome(false, "up")])).toBe("down");
    expect(aggregateHealth([outcome(true, "up"), outcome(false, "down")])).toBe("degraded");
    expect(aggregateHealth([outcome(true, "degraded")])).toBe("degraded");
    expect(aggregateHealth([outcome(true, "up"), outcome(false, "up")])).toBe("ok");
  });
});

describe("toPublicHealth", () => {
  it("never leaks raw error detail or observed values", () => {
    const view = toPublicHealth(
      {
        status: "down",
        checkedAt: "2026-01-01T00:00:00.000Z",
        dependencies: [
          {
            name: "database",
            critical: true,
            status: "down",
            latencyMs: 12,
            attempts: 2,
            detail: "connect ECONNREFUSED mongo-primary.internal:27017",
            observed: { host: "mongo-primary.internal" },
            checkedAt: "",
          },
        ],
      },
      false,
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("mongo-primary");
    expect(serialized).not.toContain("27017");
    expect(view.dependencies[0]).toEqual({
      name: "database",
      status: "down",
      critical: true,
      latencyMs: 12,
      reason: "unreachable",
    });
  });
});

describe("createHealthMonitor", () => {
  it("serves cached results within the TTL and collapses concurrent evaluations", async () => {
    let clock = 0;
    const db = check("database", true, { status: "up" });
    const monitor = createHealthMonitor({
      checks: () => [db],
      cacheTtlMs: 1_000,
      runOptions: FAST,
      now: () => clock,
    });

    const [a, b] = await Promise.all([monitor.evaluate(), monitor.evaluate()]);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);

    expect((await monitor.evaluate()).cached).toBe(true);
    clock = 1_001;
    expect((await monitor.evaluate()).cached).toBe(false);
    expect(db.run).toHaveBeenCalledTimes(2);

    await monitor.evaluate(true);
    expect(db.run).toHaveBeenCalledTimes(3);
  });
});

describe("stellarRpcCheck", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("maps the RPC getHealth answer onto dependency status", async () => {
    expect((await stellarRpcCheck("https://rpc", respond(200, { result: { status: "healthy" } })).run()).status).toBe("up");
    expect((await stellarRpcCheck("https://rpc", respond(200, { result: { status: "catching_up" } })).run()).status).toBe("degraded");
    expect((await stellarRpcCheck("https://rpc", respond(502, {})).run())).toMatchObject({
      status: "down",
      detail: "HTTP 502",
    });
  });
});

describe("indexerCheck (real MongoDB)", () => {
  let dbReady = false;
  beforeAll(async () => {
    dbReady = await setupRealMongo();
  });
  afterAll(async () => {
    await teardownRealMongo();
  });
  beforeEach(async () => {
    if (dbReady) await resetRealMongo();
  });

  it("classifies checkpoint age as up, degraded or down", async () => {
    if (!dbReady) return;
    expect((await indexerCheck().run()).status).toBe("degraded"); // no checkpoint yet

    await IndexerState.create({ key: "prompt_hash_contract", lastIndexedLedger: 42 });
    const state: any = await IndexerState.findOne({ key: "prompt_hash_contract" }).lean();
    const at = new Date(state.updatedAt).getTime();

    expect((await indexerCheck(() => at + 1_000).run()).status).toBe("up");
    expect((await indexerCheck(() => at + 120_000).run()).status).toBe("degraded");
    const stale = await indexerCheck(() => at + 3_600_000).run();
    expect(stale.status).toBe("down");
    expect(stale.observed).toMatchObject({ lastIndexedLedger: 42 });
  });
});

describe("health HTTP surface", () => {
  let http: HttpTestServer;
  const results: Record<string, CheckResult | Error> = {};
  const live = (name: string, critical: boolean): HealthCheckDefinition => ({
    name,
    critical,
    run: async () => {
      const next = results[name];
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const monitor = createHealthMonitor({
    checks: () => [live("database", true), live("stellar_rpc", false)],
    cacheTtlMs: 60_000,
    runOptions: FAST,
  });

  beforeAll(async () => {
    http = await startHttpServer((app) => app.use("/api/health", createHealthRouter(monitor)));
  });
  afterAll(async () => {
    await http.close();
  });
  beforeEach(() => {
    monitor.reset();
    results.database = { status: "up" };
    results.stellar_rpc = { status: "up" };
  });

  it("normal path: 200 ok with no-store caching", async () => {
    const res = await jsonCall(http.baseUrl, "/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.map((d: any) => d.name)).toEqual(["database", "stellar_rpc"]);
  });

  it("non-critical failure degrades but keeps serving 200", async () => {
    results.stellar_rpc = new Error("fetch failed");
    const res = await jsonCall(http.baseUrl, "/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies[1]).toMatchObject({ status: "down", reason: "unreachable" });
  });

  it("critical failure returns 503 with Retry-After and no internal detail", async () => {
    results.database = new Error("connect ECONNREFUSED 10.1.2.3:27017");
    const res = await jsonCall(http.baseUrl, "/api/health");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(JSON.stringify(res.body)).not.toContain("10.1.2.3");
  });

  it("retry path: a recovered dependency is reported once the cache is refreshed", async () => {
    results.database = new Error("ECONNREFUSED");
    expect((await jsonCall(http.baseUrl, "/api/health")).status).toBe(503);

    results.database = { status: "up" };
    // Public callers keep getting the cached answer…
    const cached = await jsonCall(http.baseUrl, "/api/health");
    expect(cached.status).toBe(503);
    expect(cached.body.cached).toBe(true);

    // …and an operator can force a fresh round.
    const admin = { "x-test-admin": "health:read" };
    const refreshed = await jsonCall(http.baseUrl, "/api/health/details?refresh=true", { headers: admin });
    expect(refreshed.status).toBe(200);
    expect((await jsonCall(http.baseUrl, "/api/health")).body.status).toBe("ok");
  });

  it("authorization path: details require health:read, the public view does not", async () => {
    results.database = new Error("connect ECONNREFUSED 10.1.2.3:27017");
    expect((await jsonCall(http.baseUrl, "/api/health")).status).toBe(503);
    expect((await jsonCall(http.baseUrl, "/api/health/details")).status).toBe(401);
    expect(
      (await jsonCall(http.baseUrl, "/api/health/details", { headers: { "x-test-admin": "flags:read" } })).status,
    ).toBe(401);

    const details = await jsonCall(http.baseUrl, "/api/health/details", {
      headers: { "x-test-admin": "health:read" },
    });
    expect(details.status).toBe(503);
    expect(details.body.dependencies[0].detail).toContain("10.1.2.3");
  });

  it("liveness never touches dependencies", async () => {
    results.database = new Error("down");
    const res = await jsonCall(http.baseUrl, "/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
