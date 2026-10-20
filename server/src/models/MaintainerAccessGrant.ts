import mongoose from "mongoose";

/**
 * Admin scopes a maintainer grant may delegate for a short window. A grant can
 * only narrow access that the approver could already exercise, and it never
 * carries read-only or token-minting scopes.
 */
export const MAINTAINER_GRANT_SCOPES = [
  "moderation:write",
  "payouts:write",
  "integrity:write",
  "entitlements:write",
  "flags:write",
] as const;

export type MaintainerGrantScope = (typeof MAINTAINER_GRANT_SCOPES)[number];

/**
 * Time-boxed maintainer access grant (#912).
 *
 * A grant is not a credential. It is a record that `approver` authorised
 * `grantee` to use the listed `scopes` until `expiresAt`. Every use must arrive
 * through an admin-authenticated request whose token `sub` equals `grantee`,
 * and `requireMaintainerGrant` re-checks expiry, revocation, and scope on each
 * call. Issuance, use, denial, and revocation are all written to the audit trail.
 */
const maintainerAccessGrantSchema = new mongoose.Schema(
  {
    grantId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Admin token `sub` of the maintainer who receives the access.
    grantee: {
      type: String,
      required: true,
      index: true,
    },
    // Admin token `sub` of the operator who approved the grant. Never the grantee.
    approver: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      required: true,
      enum: MAINTAINER_GRANT_SCOPES as unknown as string[],
    },
    reason: {
      type: String,
      required: true,
      maxLength: 500,
    },
    issuedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: String,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    useCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

maintainerAccessGrantSchema.index({ grantee: 1, expiresAt: -1 });
maintainerAccessGrantSchema.index({ revokedAt: 1, expiresAt: 1 });

const MaintainerAccessGrant =
  mongoose.models.MaintainerAccessGrant ||
  mongoose.model("MaintainerAccessGrant", maintainerAccessGrantSchema);

export default MaintainerAccessGrant;
