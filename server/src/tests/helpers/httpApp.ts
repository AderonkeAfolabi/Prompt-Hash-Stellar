import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * Shared ephemeral-HTTP helpers for route-level concurrency tests (#1041).
 *
 * Extracted from the `supportEvidenceBundleRoutes.test.ts` pattern: mount a
 * router (optionally behind real middleware) on an ephemeral port and drive it
 * with `fetch`, so the tests exercise the true middleware ordering — e.g. the
 * idempotency gate running before the handler — rather than calling a
 * controller in isolation.
 */

export interface HttpTestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Mount `configure(app)` on an ephemeral port. `express.json()` is installed
 * first so callers only declare their routes.
 */
export async function startHttpServer(
  // Callback parameter name is for the caller's signature only.
  // eslint-disable-next-line no-unused-vars
  configure: (app: express.Express) => void,
): Promise<HttpTestServer> {
  const app = express();
  app.use(express.json());
  configure(app);

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  body: any;
}

/** JSON-encoded `fetch` that always returns a parsed body plus the headers. */
export async function jsonCall(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { status: res.status, headers: res.headers, body };
}
