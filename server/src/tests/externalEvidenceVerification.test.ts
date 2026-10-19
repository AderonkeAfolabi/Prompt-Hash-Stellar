/**
 * Cryptographic verification for imported external evidence (#1011).
 *
 * Ed25519 keypairs are generated in-process; the envelope is signed exactly
 * as an external partner would sign it. Tests cover the normal import,
 * tampering, key lifecycle, issuer/scope authorisation, timestamp windows,
 * duplicate retries, nonce/evidence-id conflicts, concurrent Mongo inserts,
 * and the admin-scoped HTTP surface.
 */

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const header = String(req.headers["x-test-admin"] ?? "");
    const [sub, scopes = ""] = header.split("|");
    if (!scopes.split(",").includes(scope)) {
      res.status(401).json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    req.admin = { sub };
    next();
  },
}));

import { generateKeyPairSync, randomBytes } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExternalEvidenceRecord from "../models/ExternalEvidenceRecord";
import { externalEvidenceRouter } from "../routes/externalEvidenceRoutes";
import {
  ExternalEvidenceError,
  computeEvidencePayloadHash,
  createMemoryExternalEvidenceStore,
  createMongoExternalEvidenceStore,
  loadTrustedExternalEvidenceKeys,
  parseTrustedExternalEvidenceKeys,
  signExternalEvidence,
  verifyExternalEvidence,
  type ExternalEvidenceEnvelope,
  type TrustedExternalEvidenceKey,
} from "../services/externalEvidenceVerification";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";
import { resetRealMongo, setupRealMongo, teardownRealMongo } from "./helpers/realMongo";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = "partner-key-1";
const ISSUER = "partner-a";
const SCOPES = ["evidence:submit", "prompt:read"];

const TRUSTED: TrustedExternalEvidenceKey[] = [
  {
    keyId: KEY_ID,
    issuer: ISSUER,
    publicKey: PUBLIC_PEM,
    scopes: SCOPES,
  },
];

const WRITER = { "x-test-admin": "ops-alice|evidence:write" };
const READER = { "x-test-admin": "ops-bob|evidence:read" };

let mongoUp = false;
let http: HttpTestServer | null = null;
let sequence = 0;

function makeEnvelope(
  overrides: Partial<Parameters<typeof signExternalEvidence>[0]> = {},
): ExternalEvidenceEnvelope {
  sequence += 1;
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  return signExternalEvidence(
    {
      evidenceId: `evidence-${sequence}`,
      issuer: ISSUER,
      scope: "evidence:submit",
      payload: { subject: `prompt-${sequence}`, score: 42 },
      issuedAt,
      nonce: `nonce-${sequence}`,
      keyId: KEY_ID,
      ...overrides,
    },
    privateKey,
  );
}

function rewriteSignature(envelope: ExternalEvidenceEnvelope, signature?: string): void {
  envelope.signature = signature ?? randomBytes(64).toString("base64");
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ExternalEvidenceError);
  expect((error as ExternalEvidenceError).code).toBe(code);
}

beforeAll(async () => {
  mongoUp = await setupRealMongo();
  if (mongoUp) await ExternalEvidenceRecord.init();
  process.env.EXTERNAL_EVIDENCE_TRUSTED_KEYS = JSON.stringify(TRUSTED);
  http = await startHttpServer((app) => app.use("/api/external-evidence", externalEvidenceRouter));
}, 60_000);

afterAll(async () => {
  delete process.env.EXTERNAL_EVIDENCE_TRUSTED_KEYS;
  await http?.close();
  await teardownRealMongo();
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  if (mongoUp) await resetRealMongo();
});

afterEach(() => {
  delete process.env.EXTERNAL_EVIDENCE_TRUSTED_KEYS;
  process.env.EXTERNAL_EVIDENCE_TRUSTED_KEYS = JSON.stringify(TRUSTED);
});

describe("trusted key registry", () => {
  it("loads the registry from JSON and accepts PEM, SPKI DER and raw keys", () => {
    const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const raw = Buffer.from(
      publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    ).toString("base64");

    for (const material of [PUBLIC_PEM, der, raw]) {
      const keys = parseTrustedExternalEvidenceKeys(
        JSON.stringify([{ keyId: KEY_ID, issuer: ISSUER, publicKey: material, scopes: ["*"] }]),
      );
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ keyId: KEY_ID, issuer: ISSUER, scopes: ["*"] });
    }
  });

  it("fails closed when the registry is missing or malformed", () => {
    expect(() => parseTrustedExternalEvidenceKeys("not-json")).toThrowError(
      ExternalEvidenceError,
    );
    expectCode(
      (() => {
        try {
          loadTrustedExternalEvidenceKeys({});
        } catch (err) {
          return err;
        }
      })(),
      "trusted_keys_unconfigured",
    );
    expectCode(
      (() => {
        try {
          parseTrustedExternalEvidenceKeys("[]");
        } catch (err) {
          return err;
        }
      })(),
      "trusted_keys_unconfigured",
    );
  });
});

describe("verification", () => {
  it("normal path: verifies and stores a signed envelope", async () => {
    const store = createMemoryExternalEvidenceStore();
    const envelope = makeEnvelope();

    const result = await verifyExternalEvidence(envelope, { trustedKeys: TRUSTED, store });

    expect(result).toMatchObject({
      evidenceId: envelope.evidenceId,
      issuer: ISSUER,
      scope: "evidence:submit",
      keyId: KEY_ID,
      payload: envelope.payload,
      status: "verified",
      duplicate: false,
    });
    expect(result.payloadHash).toBe(computeEvidencePayloadHash(envelope.payload));
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt).toBeNull();
    expect(await store.findByEvidenceId(envelope.evidenceId)).not.toBeNull();
  });

  it("treats an identical retry as a duplicate without storing twice", async () => {
    const store = createMemoryExternalEvidenceStore();
    const envelope = makeEnvelope();

    const first = await verifyExternalEvidence(envelope, { trustedKeys: TRUSTED, store });
    const retry = await verifyExternalEvidence(envelope, { trustedKeys: TRUSTED, store });

    expect(retry.duplicate).toBe(true);
    expect(retry.fingerprint).toBe(first.fingerprint);
    expect(retry.receivedAt).toBe(first.receivedAt);
  });

  it("rejects a payload changed after signing", async () => {
    const envelope = makeEnvelope();
    envelope.payload = { ...(envelope.payload as Record<string, unknown>), score: 1 };

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "payload_hash_mismatch" });
  });

  it("rejects a forged signature and reflects nothing", async () => {
    const store = createMemoryExternalEvidenceStore();
    const envelope = makeEnvelope();
    rewriteSignature(envelope);

    await expect(verifyExternalEvidence(envelope, { trustedKeys: TRUSTED, store })).rejects.toMatchObject({ code: "invalid_signature" });
    expect(await store.findByEvidenceId(envelope.evidenceId)).toBeNull();
  });

  it("rejects metadata altered after signing even when the new scope is granted", async () => {
    const envelope = makeEnvelope();
    envelope.scope = "prompt:read";

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects an unknown key id", async () => {
    const envelope = makeEnvelope({ keyId: "unknown-key" });

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "unknown_key" });
  });

  it("rejects a revoked key before considering the signature", async () => {
    const revoked: TrustedExternalEvidenceKey[] = [
      { ...TRUSTED[0], revokedAt: new Date(Date.now() - 60_000).toISOString() },
    ];
    const envelope = makeEnvelope();

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: revoked,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "revoked_key" });
  });

  it("enforces key validity windows", async () => {
    const notYet: TrustedExternalEvidenceKey[] = [
      { ...TRUSTED[0], notBefore: new Date(Date.now() + 60 * 60_000).toISOString() },
    ];
    const expired: TrustedExternalEvidenceKey[] = [
      { ...TRUSTED[0], expiresAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    ];

    await expect(
      verifyExternalEvidence(makeEnvelope(), {
        trustedKeys: notYet,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "key_not_yet_valid" });

    await expect(
      verifyExternalEvidence(makeEnvelope(), {
        trustedKeys: expired,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "key_expired" });
  });

  it("rejects evidence whose issuer does not own the signing key", async () => {
    const envelope = makeEnvelope({ issuer: "partner-b" });

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
  });

  it("rejects a scope the key was not granted", async () => {
    const envelope = makeEnvelope({ scope: "admin:write" });

    await expect(
      verifyExternalEvidence(envelope, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "scope_not_allowed" });
  });

  it("honours wildcard scope grants", async () => {
    const wildcard: TrustedExternalEvidenceKey[] = [{ ...TRUSTED[0], scopes: ["evidence:*"] }];
    const envelope = makeEnvelope({ scope: "evidence:submit:batch" });

    const result = await verifyExternalEvidence(envelope, {
      trustedKeys: wildcard,
      store: createMemoryExternalEvidenceStore(),
    });
    expect(result.status).toBe("verified");
  });

  it("rejects expired and future-dated evidence", async () => {
    const expired = makeEnvelope({
      issuedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const fromFuture = makeEnvelope({
      issuedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    await expect(
      verifyExternalEvidence(expired, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "evidence_expired" });

    await expect(
      verifyExternalEvidence(fromFuture, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
      }),
    ).rejects.toMatchObject({ code: "evidence_from_future" });
  });

  it("rejects evidence older than the configured acceptance window", async () => {
    const old = makeEnvelope({
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    await expect(
      verifyExternalEvidence(old, {
        trustedKeys: TRUSTED,
        store: createMemoryExternalEvidenceStore(),
        maxAgeMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "evidence_too_old" });
  });

  it("rejects malformed envelopes before touching the store", async () => {
    const missingSignature = { ...makeEnvelope() } as Record<string, unknown>;
    delete missingSignature.signature;

    for (const input of [null, {}, missingSignature, { ...makeEnvelope(), payloadHash: "abc" }]) {
      await expect(
        verifyExternalEvidence(input, {
          trustedKeys: TRUSTED,
          store: createMemoryExternalEvidenceStore(),
        }),
      ).rejects.toMatchObject({ code: "invalid_envelope" });
    }

    expect(() =>
      signExternalEvidence(
        {
          evidenceId: "cyclic",
          issuer: ISSUER,
          scope: "evidence:submit",
          payload: (() => {
            const value: Record<string, unknown> = {};
            value.self = value;
            return value;
          })(),
          issuedAt: new Date().toISOString(),
          nonce: "cyclic-nonce",
          keyId: KEY_ID,
        },
        privateKey,
      ),
    ).toThrowError(ExternalEvidenceError);
  });

  it("rejects a reused nonce under a different evidence id", async () => {
    const store = createMemoryExternalEvidenceStore();
    const first = makeEnvelope();
    const second = makeEnvelope({ nonce: first.nonce });

    await verifyExternalEvidence(first, { trustedKeys: TRUSTED, store });
    await expect(verifyExternalEvidence(second, { trustedKeys: TRUSTED, store })).rejects.toMatchObject({ code: "nonce_reuse" });
    expect(await store.findByEvidenceId(second.evidenceId)).toBeNull();
  });

  it("rejects a conflicting reuse of an evidence id", async () => {
    const store = createMemoryExternalEvidenceStore();
    const first = makeEnvelope();
    const conflict = makeEnvelope({ evidenceId: first.evidenceId });

    await verifyExternalEvidence(first, { trustedKeys: TRUSTED, store });
    await expect(verifyExternalEvidence(conflict, { trustedKeys: TRUSTED, store })).rejects.toMatchObject({ code: "evidence_conflict" });
  });
});

describe("Mongo-backed replay store", () => {
  it("collapses a concurrent identical import into one verified record", async () => {
    if (!mongoUp) return;
    const store = createMongoExternalEvidenceStore();
    const envelope = makeEnvelope();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyExternalEvidence(envelope, { trustedKeys: TRUSTED, store })),
    );

    expect(results.filter((entry) => entry.duplicate === false)).toHaveLength(1);
    expect(results.filter((entry) => entry.duplicate === true)).toHaveLength(4);
    expect(await ExternalEvidenceRecord.countDocuments({ evidenceId: envelope.evidenceId })).toBe(1);
  });

  it("serialises a conflicting concurrent reuse of one evidence id", async () => {
    if (!mongoUp) return;
    const store = createMongoExternalEvidenceStore();
    const first = makeEnvelope();
    const second = makeEnvelope({ evidenceId: first.evidenceId });

    const settled = await Promise.allSettled([
      verifyExternalEvidence(first, { trustedKeys: TRUSTED, store }),
      verifyExternalEvidence(second, { trustedKeys: TRUSTED, store }),
    ]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expectCode(rejected.reason, "evidence_conflict");
    expect(await ExternalEvidenceRecord.countDocuments({ evidenceId: first.evidenceId })).toBe(1);
  });

  it("enforces the unique (issuer, nonce) index at the database boundary", async () => {
    if (!mongoUp) return;
    const store = createMongoExternalEvidenceStore();
    const first = makeEnvelope();
    const second = makeEnvelope({ nonce: first.nonce });

    const settled = await Promise.allSettled([
      verifyExternalEvidence(first, { trustedKeys: TRUSTED, store }),
      verifyExternalEvidence(second, { trustedKeys: TRUSTED, store }),
    ]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expectCode(rejected.reason, "nonce_reuse");
    expect(await ExternalEvidenceRecord.countDocuments()).toBe(1);
  });
});

describe("external evidence HTTP surface", () => {
  it("requires evidence:write to verify and evidence:read to read", async () => {
    if (!mongoUp || !http) return;

    expect(
      (await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
        method: "POST",
        body: JSON.stringify(makeEnvelope()),
      })).status,
    ).toBe(401);

    expect(
      (await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
        method: "POST",
        headers: READER,
        body: JSON.stringify(makeEnvelope()),
      })).status,
    ).toBe(401);

    expect(
      (await jsonCall(http.baseUrl, "/api/external-evidence/anything", { headers: WRITER })).status,
    ).toBe(401);
  });

  it("imports once, answers retries with 200, and exposes the stored evidence", async () => {
    if (!mongoUp || !http) return;
    const envelope = makeEnvelope();

    const created = await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify(envelope),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      evidenceId: envelope.evidenceId,
      status: "verified",
      duplicate: false,
    });

    const retried = await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify(envelope),
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ duplicate: true, fingerprint: created.body.fingerprint });
    expect(await ExternalEvidenceRecord.countDocuments()).toBe(1);

    const read = await jsonCall(
      http.baseUrl,
      `/api/external-evidence/${encodeURIComponent(envelope.evidenceId)}`,
      { headers: READER },
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      evidenceId: envelope.evidenceId,
      issuer: ISSUER,
      payload: envelope.payload,
      status: "verified",
    });

    expect(
      (await jsonCall(http.baseUrl, "/api/external-evidence/missing", { headers: READER })).status,
    ).toBe(404);
  });

  it("maps verification failures to their stable HTTP status without storing them", async () => {
    if (!mongoUp || !http) return;
    const tampered = makeEnvelope();
    tampered.payload = { forged: true };

    const res = await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("payload_hash_mismatch");
    expect(await ExternalEvidenceRecord.countDocuments()).toBe(0);
  });

  it("fails closed with 503 when no trusted keys are configured", async () => {
    if (!mongoUp || !http) return;
    delete process.env.EXTERNAL_EVIDENCE_TRUSTED_KEYS;

    const res = await jsonCall(http.baseUrl, "/api/external-evidence/verify", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify(makeEnvelope()),
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("trusted_keys_unconfigured");
  });
});
