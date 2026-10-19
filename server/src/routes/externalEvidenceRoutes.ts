import express from "express";
import { requireAdminScope } from "../middleware/adminAuth";
import {
  ExternalEvidenceError,
  createMongoExternalEvidenceStore,
  loadTrustedExternalEvidenceKeys,
  verifyExternalEvidence,
} from "../services/externalEvidenceVerification";

/**
 * External evidence import routes (#1011).
 *
 * POST /api/external-evidence/verify — verify + persist a signed envelope
 * GET  /api/external-evidence/:evidenceId — read a previously verified record
 *
 * Imports require `evidence:write`; reads require `evidence:read`. The
 * signing key belongs to the external issuer, while the admin token belongs
 * to the operator performing the import — both are required.
 */

export const externalEvidenceRouter = express.Router();

function sendError(res: express.Response, err: unknown): void {
  if (err instanceof ExternalEvidenceError) {
    res.status(err.httpStatus).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  console.error("[external-evidence] unexpected verification failure:", err);
  res.status(500).json({ error: "external_evidence_internal_error" });
}

externalEvidenceRouter.post(
  "/verify",
  requireAdminScope("evidence:write"),
  async (req, res) => {
    try {
      const trustedKeys = loadTrustedExternalEvidenceKeys();
      const result = await verifyExternalEvidence(req.body, {
        trustedKeys,
        store: createMongoExternalEvidenceStore(),
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  },
);

externalEvidenceRouter.get(
  "/:evidenceId",
  requireAdminScope("evidence:read"),
  async (req, res) => {
    try {
      const store = createMongoExternalEvidenceStore();
      const record = await store.findByEvidenceId(String(req.params.evidenceId));
      if (!record) {
        res.status(404).json({ error: "evidence_not_found" });
        return;
      }
      res.json({
        evidenceId: record.evidenceId,
        issuer: record.issuer,
        scope: record.scope,
        keyId: record.keyId,
        nonce: record.nonce,
        payloadHash: record.payloadHash,
        fingerprint: record.fingerprint,
        payload: record.payload,
        issuedAt: new Date(record.issuedAt).toISOString(),
        expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        receivedAt: new Date(record.receivedAt).toISOString(),
        status: record.status,
      });
    } catch (err) {
      sendError(res, err);
    }
  },
);
