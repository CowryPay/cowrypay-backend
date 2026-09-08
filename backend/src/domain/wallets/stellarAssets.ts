// Single source of truth for which assets Stellar actually supports and
// their issuers — the equivalent of chains.ts's per-chain tokens map for
// EVM chains, just shaped for Stellar's one-shared-account, code+issuer
// asset model instead. Was a single hardcoded USDC Asset scattered across
// stellarAdapter.ts/stellarDepositScanner.ts/refundVerification.ts/
// admin/treasury.ts/admin/stellarDepositDiagnostic.ts until USDT0 support
// was added (2026-09-08) — centralized here so adding the next asset
// means one edit, not five separately-remembered ones.
import { Asset } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";

interface StellarAssetDef {
  code: string;
  requireIssuer(): string;
}

const STELLAR_ASSETS: Record<string, StellarAssetDef> = {
  USDC: {
    code: "USDC",
    requireIssuer: () => {
      if (!env.stellarUsdcIssuer) throw new Error("STELLAR_USDC_ISSUER must be set");
      return env.stellarUsdcIssuer;
    },
  },
  USDT0: {
    code: "USDT0",
    requireIssuer: () => {
      if (!env.stellarUsdt0Issuer) throw new Error("STELLAR_USDT0_ISSUER must be set");
      return env.stellarUsdt0Issuer;
    },
  },
};

export function stellarSupportedTokens(): string[] {
  return Object.keys(STELLAR_ASSETS);
}

// Builds a real SDK Asset for signing/submitting a payment — throws if the
// symbol isn't recognized or its issuer env var isn't configured, same
// contract as chains.ts's getTokenConfig.
export function resolveStellarAsset(tokenSymbol: string): Asset {
  const def = STELLAR_ASSETS[tokenSymbol.toUpperCase()];
  if (!def) {
    throw new Error(`Stellar doesn't support tokenSymbol=${tokenSymbol} yet (only ${stellarSupportedTokens().join(", ")})`);
  }
  return new Asset(def.code, def.requireIssuer());
}

// The reverse direction — given an asset_code/asset_issuer pair observed on
// Horizon (a payment op, a balance line, a Soroban asset_balance_change),
// which of our known tokenSymbols does it match, if any? Used everywhere
// that reads real on-chain data rather than builds a payment: the deposit
// scanner, the unmatched-deposit diagnostic, refund verification, and the
// treasury balance snapshot. Returns null for anything unrecognized
// (native XLM, some other asset entirely) rather than throwing — an
// unrecognized asset landing on our account is normal/expected (someone
// sent the wrong thing), not an error condition.
export function identifyStellarToken(assetCode: string | undefined, assetIssuer: string | undefined): string | null {
  if (!assetCode || !assetIssuer) return null;
  for (const [symbol, def] of Object.entries(STELLAR_ASSETS)) {
    if (def.code !== assetCode) continue;
    try {
      if (def.requireIssuer() === assetIssuer) return symbol;
    } catch {
      // This asset's issuer env var isn't configured — can't match it, not an error.
    }
  }
  return null;
}
