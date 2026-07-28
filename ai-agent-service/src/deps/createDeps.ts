import { createDefaultRegistry } from "../resolvers.js";
import { createChainResolutionDeps } from "./chainResolution.js";
import { createMockResolutionDeps } from "./mockResolution.js";
import type { ResolutionDeps } from "./types.js";

/**
 * If CELO_RPC_URL or RPC_URL is set, uses on-chain UsernameRegistry + GroupRegistry reads.
 * Otherwise uses the in-memory mock registry (tests / offline).
 */
export function createResolutionDeps(): ResolutionDeps {
  const rpc =
    process.env.CELO_RPC_URL?.trim() || process.env.RPC_URL?.trim() || "";
  if (rpc) {
    return createChainResolutionDeps(rpc);
  }
  return createMockResolutionDeps(createDefaultRegistry());
}
