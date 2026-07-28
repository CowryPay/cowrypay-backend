import { getAgentWallet } from "./wallet.js";
import { getAgentIdStatus } from "./selfId.js";
import type { PublicClient } from "viem";

export type AgentIdentity = {
  address: `0x${string}`;
  erc8004?: {
    registered: boolean;
    agentId?: string;
    hint?: string;
  };
};

/** Agent EOA from AGENT_PRIVATE_KEY, or null if not configured. */
export function getAgentAddressOrNull(): `0x${string}` | null {
  try {
    return getAgentWallet().address;
  } catch {
    return null;
  }
}

/** Cowry AI agent identity for API responses (ERC-8004 when RPC available). */
export async function getAgentIdentity(
  client?: PublicClient | null,
): Promise<AgentIdentity | null> {
  const address = getAgentAddressOrNull();
  if (!address) return null;

  if (!client) {
    return { address };
  }

  try {
    const status = await getAgentIdStatus(client, address);
    if (status.registered) {
      return {
        address,
        erc8004: { registered: true, agentId: status.agentId.toString() },
      };
    }
    return {
      address,
      erc8004: { registered: false, hint: status.hint },
    };
  } catch {
    return { address };
  }
}
