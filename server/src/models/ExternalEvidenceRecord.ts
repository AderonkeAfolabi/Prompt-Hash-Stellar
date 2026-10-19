import mongoose from "mongoose";

/**
 * Verified external evidence (#1011).
 *
 * Only evidence that passed signature, hash, issuer, scope, timestamp and
 * replay checks is written here. `evidenceId` and `(issuer, nonce)` are
 * unique so duplicate imports collapse at the database boundary even when
 * two server instances verify the same envelope concurrently.
 */

const externalEvidenceRecordSchema = new mongoose.Schema(
  {
    evidenceId: { type: String, required: true, unique: true, index: true },
    issuer: { type: String, required: true, index: true },
    scope: { type: String, required: true, index: true },
    keyId: { type: String, required: true },
    nonce: { type: String, required: true },
    payloadHash: { type: String, required: true },
    fingerprint: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    status: {
      type: String,
      required: true,
      enum: ["verified"],
      default: "verified",
    },
  },
  { timestamps: true },
);

externalEvidenceRecordSchema.index({ issuer: 1, nonce: 1 }, { unique: true });

const ExternalEvidenceRecord =
  mongoose.models.ExternalEvidenceRecord ||
  mongoose.model("ExternalEvidenceRecord", externalEvidenceRecordSchema);

export default ExternalEvidenceRecord;
