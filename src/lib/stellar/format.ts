/**
 * Converts stroops (smallest unit) to XLM string
 * 1 XLM = 10,000,000 stroops
 */
export function stroopsToXlmString(stroops: bigint): string {
  const xlm = Number(stroops) / 10_000_000;
  return xlm.toString();
}

/**
 * Converts XLM to stroops
 */
export function xlmToStroops(xlm: number | string): bigint {
  if (typeof xlm === "number") {
    if (!Number.isFinite(xlm)) {
      throw new RangeError("XLM amount must be a finite number");
    }
    const stroops = Math.round(xlm * 10_000_000);
    if (!Number.isSafeInteger(stroops)) {
      throw new RangeError(
        "XLM amount exceeds the safely representable numeric range",
      );
    }
    return BigInt(stroops);
  }

  const value = xlm.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) {
    throw new TypeError(
      "Enter a valid XLM amount with up to 7 decimal places.",
    );
  }

  const [, sign, whole, fraction = ""] = match;
  const stroops = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
  return sign === "-" ? -stroops : stroops;
}

/**
 * Formats a price in stroops as a human-readable XLM label.
 */
export function formatPriceLabel(stroops: bigint): string {
  const xlmStr = stroopsToXlmString(stroops);
  return `${xlmStr} XLM`;
}

/**
 * Formats an address for display (truncated)
 */
export function formatAddress(
  address: string,
  prefixLength = 8,
  suffixLength = 4,
): string {
  if (address.length <= prefixLength + suffixLength) {
    return address;
  }
  return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}
