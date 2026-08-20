import type { BridgeAdapter } from "./adapter.js";
import { cctpAdapter } from "./cctpAdapter.js";
import { liFiAdapter } from "./liFiAdapter.js";

// Mirrors wallets/index.ts's getWalletAdapter dispatch pattern — callers
// (service.ts, the poller) call this once and never branch on vendor
// again. Celo isn't a CCTP domain at all (confirmed against both Circle's
// docs and their own SDK internals) — any Celo-touching leg routes to
// liFiAdapter.ts instead, which composes whichever underlying bridge +
// swap actually delivers the real, canonical destination token.
export function getBridgeAdapter(sourceChain: string, destinationChain: string): BridgeAdapter {
  if (sourceChain.toLowerCase() === "celo" || destinationChain.toLowerCase() === "celo") {
    return liFiAdapter;
  }
  return cctpAdapter;
}
