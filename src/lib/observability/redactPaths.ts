// Fields to redact from logs for privacy and security.
// Kept in its own module (no logger dependency) so the contract can be tested directly.
export const REDACT_PATHS: readonly string[] = [
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
  // Wallet addresses are hashed before structured audit logs; raw values
  // must not appear in log output (#224).
  "walletAddress",
  "address",
  "body.address",
  "body.walletAddress",
];

export const REDACTED_CENSOR = "[REDACTED]";
