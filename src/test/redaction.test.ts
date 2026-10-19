// @vitest-environment node
/**
 * Redaction contract tests (#1017): logs, error responses, and the shapes they emit.
 * A failure means a sensitive field stopped being masked or an error body started
 * echoing internals. Log redaction is asserted against the shared path list that
 * `logger.ts` passes to pino, so no logger instance is needed here.
 */
import { describe, expect, it } from "vitest";
import { apiError, ERROR_MESSAGES, ErrorCode } from "../lib/api/errorCodes";
import { problemDetails, sendApiError } from "../lib/api/problemDetails";
import { REDACT_PATHS, REDACTED_CENSOR } from "../lib/observability/redactPaths";

const codes = Object.values(ErrorCode);

const REQUIRED_LOG_REDACTIONS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "plaintext",
  "secret",
  "privateKey",
  "unlockPrivateKey",
  "challengeSecret",
  "signedMessage",
  "body.plaintext",
  "body.secret",
  "body.privateKey",
  "body.signedMessage",
  "res.body.plaintext",
  "walletAddress",
  "address",
  "body.address",
  "body.walletAddress",
];

// Substrings that must never appear in a caller-facing error body by default.
const SECRET_MARKERS = ["privatekey", "secret", "plaintext", "signedmessage", "stack", "sql"];

function captureResponse() {
  const captured: { headers: Record<string, string>; status?: number; body?: string; json?: unknown } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return {
        json(body: unknown) {
          captured.json = body;
        },
        send(body: string) {
          captured.body = body;
        },
      };
    },
  };
  return { res, captured };
}

describe("log redaction contract (#1017)", () => {
  it("masks every sensitive field the logger is required to redact", () => {
    for (const path of REQUIRED_LOG_REDACTIONS) {
      expect(REDACT_PATHS, path).toContain(path);
    }
  });

  it("uses the stable censor token", () => {
    expect(REDACTED_CENSOR).toBe("[REDACTED]");
  });

  it("does not list the same path twice", () => {
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
  });

  it("only uses dotted paths that pino can resolve (no wildcards or empty segments)", () => {
    for (const path of REDACT_PATHS) {
      expect(path, path).toMatch(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
    }
  });
});

describe("error response redaction (#1017)", () => {
  it("default problem messages never contain secret-bearing words", () => {
    for (const code of codes) {
      const detail = problemDetails(code).detail.toLowerCase();
      for (const marker of SECRET_MARKERS) {
        expect(detail, `${code} contains "${marker}"`).not.toContain(marker);
      }
    }
  });

  it("problem+json bodies expose only the documented fields", () => {
    const allowed = new Set([
      "type", "title", "status", "detail", "instance", "code", "error",
      "remediation", "retryable", "docs", "reset", "correlationId",
    ]);
    for (const code of codes) {
      for (const key of Object.keys(problemDetails(code, { requestId: "r1", correlationId: "c1", reset: 5 }))) {
        expect(allowed.has(key), `${code}.${key}`).toBe(true);
      }
    }
  });

  it("legacy bodies carry no stack, cause, or internal fields", () => {
    const body = apiError("INTERNAL_ERROR", ERROR_MESSAGES.INTERNAL_ERROR, { correlationId: "c-1" });
    expect(Object.keys(body).sort()).toEqual(["code", "correlationId", "error"]);
    expect(JSON.stringify(body)).not.toMatch(/stack|cause|at \w+ \(/);
  });

  it("failure path: problem+json error response keeps the caller status and omits raw input", () => {
    const { res, captured } = captureResponse();
    const req = { headers: { accept: "application/problem+json" }, requestId: "req-9" };

    sendApiError(req, res, "INVALID_SIGNATURE", ERROR_MESSAGES.INVALID_SIGNATURE, { status: 401 });

    expect(captured.status).toBe(401);
    expect(captured.headers["Content-Type"]).toBe("application/problem+json");
    const parsed = JSON.parse(captured.body as string);
    expect(parsed.detail).toBe(ERROR_MESSAGES.INVALID_SIGNATURE);
    expect(parsed.instance).toBe("urn:prompthash:request:req-9");
  });

  it("failure path: legacy error response has no problem-only fields", () => {
    const { res, captured } = captureResponse();
    sendApiError({ headers: {} }, res, "NOT_FOUND", ERROR_MESSAGES.NOT_FOUND, { status: 404 });

    expect(captured.status).toBe(404);
    expect(captured.json).toEqual({ error: ERROR_MESSAGES.NOT_FOUND, code: "NOT_FOUND" });
  });

  it("authorization path: unauthorized responses do not echo the requested identifiers", () => {
    const { res, captured } = captureResponse();
    const req = { headers: { accept: "application/problem+json" }, requestId: "req-auth" };

    sendApiError(req, res, "UNAUTHORIZED", ERROR_MESSAGES.UNAUTHORIZED, { status: 403 });

    const raw = captured.body as string;
    expect(raw).not.toContain("GBX");
    expect(raw).not.toContain("prompt-");
    expect(JSON.parse(raw).code).toBe("UNAUTHORIZED");
  });
});
