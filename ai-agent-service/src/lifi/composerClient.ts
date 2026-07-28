/**
 * LI.FI Composer API client
 * Endpoint: https://li.quest/v1/quote  (GET)
 * Authentication: optional API key via x-lifi-api-key header
 *
 * Builds deposit transaction calldata for any LI.FI Earn vault.
 * The Composer handles routing, bridging, and encoding in one call.
 */
import type { ComposerQuote } from "./types.js";

const COMPOSER_BASE = "https://li.quest";
const INTEGRATOR    = process.env.LIFI_INTEGRATOR?.trim() || "cowry";

export interface DepositQuoteParams {
  /** The LI.FI opportunity ID from the Earn Data API */
  opportunityId: string;
  /** Chain where the vault lives (and where the user's USDC is) */
  fromChainId: number;
  /** USDC token address on that chain */
  fromTokenAddress: string;
  /** Amount in base units (e.g. 100 USDC = "100000000" for 6 decimals) */
  fromAmount: string;
  /** The user's EVM wallet address */
  fromAddress: string;
  /** Vault contract address (toToken for the Composer) */
  toTokenAddress: string;
}

/**
 * Request a deposit transaction from the LI.FI Composer.
 *
 * Returns calldata (to, data, value, chainId) that can be signed
 * and broadcast directly via Privy.
 */
export async function getDepositQuote(
  params: DepositQuoteParams,
): Promise<ComposerQuote> {
  const apiKey = process.env.LIFI_API_KEY?.trim();

  const url = new URL(`${COMPOSER_BASE}/v1/quote`);
  url.searchParams.set("fromChain",    String(params.fromChainId));
  url.searchParams.set("toChain",      String(params.fromChainId));   // same-chain deposit
  url.searchParams.set("fromToken",    params.fromTokenAddress);
  url.searchParams.set("toToken",      params.toTokenAddress);
  url.searchParams.set("fromAmount",   params.fromAmount);
  url.searchParams.set("fromAddress",  params.fromAddress);
  url.searchParams.set("integrator",   INTEGRATOR);
  // Pass opportunityId so Composer knows to route into the correct vault
  url.searchParams.set("opportunityId", params.opportunityId);

  const headers: Record<string, string> = {
    "Accept":       "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-lifi-api-key"] = apiKey;
  } else {
    console.warn("[LI.FI Composer] No LIFI_API_KEY set — rate limits may apply.");
  }

  const res = await fetch(url.toString(), { headers });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as { message?: string };
      detail = body.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(
      `LI.FI Composer error ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  return res.json() as Promise<ComposerQuote>;
}

/**
 * Convert a human USDC amount (e.g. 100) to base units string ("100000000")
 * for the Composer's fromAmount parameter.
 */
export function toBaseUnits(humanAmount: number, decimals: number): string {
  return String(Math.round(humanAmount * 10 ** decimals));
}

/**
 * Estimate daily earnings for a given deposit amount and APY.
 * Returns a formatted string, e.g. "~$0.05"
 */
export function estimateDailyEarnings(amountUsd: number, apy: number): string {
  // apy is in percent (e.g. 3.89 = 3.89%), so divide by 100 first
  const daily = (amountUsd * (apy / 100)) / 365;
  return `~$${daily.toFixed(4)}`;
}
