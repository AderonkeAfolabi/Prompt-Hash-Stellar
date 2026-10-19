import { Keypair } from "@stellar/stellar-sdk";
import {
  runSyntheticJourney,
  type SyntheticMode,
} from "../src/services/syntheticJourneyMonitor";

const mode = (process.env.SYNTHETIC_MODE ??
  "authorization-probe") as SyntheticMode;
const secret = process.env.SYNTHETIC_BUYER_SECRET;
const keypair = secret ? Keypair.fromSecret(secret) : undefined;
const buyerAddress =
  process.env.SYNTHETIC_BUYER_ADDRESS ?? keypair?.publicKey();

if (
  !process.env.SYNTHETIC_BASE_URL ||
  !process.env.SYNTHETIC_PROMPT_ID ||
  !buyerAddress
) {
  console.error(
    "SYNTHETIC_BASE_URL, SYNTHETIC_PROMPT_ID, and a synthetic buyer address are required.",
  );
  process.exit(2);
}
if (mode !== "authorized" && mode !== "authorization-probe") {
  console.error("SYNTHETIC_MODE must be authorized or authorization-probe.");
  process.exit(2);
}
if (mode === "authorized" && !keypair) {
  console.error("SYNTHETIC_BUYER_SECRET is required in authorized mode.");
  process.exit(2);
}

async function main(): Promise<void> {
  const result = await runSyntheticJourney(
    {
      baseUrl: process.env.SYNTHETIC_BASE_URL!,
      promptId: process.env.SYNTHETIC_PROMPT_ID!,
      buyerAddress: buyerAddress!,
      mode,
    },
    {
      fetch: globalThis.fetch,
      signChallenge: keypair
        ? (challenge) =>
            Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString(
              "base64",
            )
        : undefined,
    },
  );

  console.log(JSON.stringify(result));
  process.exitCode = result.success ? 0 : 1;
}

void main().catch(() => {
  console.error("Synthetic journey runner failed.");
  process.exitCode = 1;
});
