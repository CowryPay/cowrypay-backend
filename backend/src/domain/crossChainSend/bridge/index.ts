import type { BridgeAdapter } from "./adapter.js";
import { cctpAdapter } from "./cctpAdapter.js";
import { liFiAdapter } from "./liFiAdapter.js";
import { stellarCctpAdapter } from "./stellarCctpAdapter.js";

// Mirrors wallets/index.ts's getWalletAdapter dispatch pattern — callers
// (service.ts, the poller) call this once and never branch on vendor
// again. Celo isn't a CCTP domain at all (confirmed against both Circle's
// docs and their own SDK internals) — any Celo-touching leg routes to
// liFiAdapter.ts instead, which composes whichever underlying bridge +
// swap actually delivers the real, canonical destination token. Stellar
// IS a CCTP domain but has no official Circle adapter package (hand-built
// Soroban integration instead, see stellarCctpAdapter.ts/
// stellarCctpSoroban.ts) — checked ahead of the plain CCTP fallback,
// same as the Celo check. Currently Base/Optimism/Solana -> Stellar only
// (stellarCctpAdapter's own supports() is the honest answer for exactly
// which pairs work right now — Stellar as SOURCE isn't built yet).
export function getBridgeAdapter(sourceChain: string, destinationChain: string): BridgeAdapter {
  if (sourceChain.toLowerCase() === "celo" || destinationChain.toLowerCase() === "celo") {
    return liFiAdapter;
  }
  if (sourceChain.toLowerCase() === "stellar" || destinationChain.toLowerCase() === "stellar") {
    return stellarCctpAdapter;
  }
  return cctpAdapter;
}
