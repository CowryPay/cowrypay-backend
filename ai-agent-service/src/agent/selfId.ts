import { SelfAgent } from "@selfxyz/agent-sdk";
import type { PublicClient } from "viem";

// ── Contract addresses (Celo mainnet) ─────────────────────────────────────────
export const SELF_AGENT_REGISTRY = "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944" as const;
export const SELF_HUMAN_PROOF_PROVIDER = "0x4b036aFD959B457A208F676cf44Ea3ef73Ea3E3d" as const;

const REGISTRY_ABI = [
  {
    name: "isVerifiedAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentKey", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getAgentId",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentKey", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Convert an Ethereum address to the bytes32 agent key used by the registry. */
function addressToAgentKey(address: `0x${string}`): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

// ── SelfAgent singleton ───────────────────────────────────────────────────────

let _selfAgent: SelfAgent | null = null;

export function getSelfAgent(): SelfAgent {
  if (_selfAgent) return _selfAgent;
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY not set");
  _selfAgent = new SelfAgent({ privateKey: pk, network: "mainnet" });
  return _selfAgent;
}

// ── Onchain registry checks ───────────────────────────────────────────────────

export async function isAgentVerified(
  client: PublicClient,
  agentAddress: `0x${string}`,
): Promise<boolean> {
  const agentKey = addressToAgentKey(agentAddress);
  return client.readContract({
    address: SELF_AGENT_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "isVerifiedAgent",
    args: [agentKey as `0x${string}`],
  }) as Promise<boolean>;
}

export async function getAgentNftId(
  client: PublicClient,
  agentAddress: `0x${string}`,
): Promise<bigint | null> {
  const agentKey = addressToAgentKey(agentAddress);
  try {
    const id = await client.readContract({
      address: SELF_AGENT_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "getAgentId",
      args: [agentKey as `0x${string}`],
    }) as bigint;
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

// ── Status helper ─────────────────────────────────────────────────────────────

export type AgentIdStatus =
  | { registered: true; agentId: bigint; agentAddress: `0x${string}` }
  | { registered: false; agentAddress: `0x${string}`; hint: string };

export async function getAgentIdStatus(
  client: PublicClient,
  agentAddress: `0x${string}`,
): Promise<AgentIdStatus> {
  const [verified, nftId] = await Promise.all([
    isAgentVerified(client, agentAddress),
    getAgentNftId(client, agentAddress),
  ]);

  if (verified && nftId !== null) {
    return { registered: true, agentId: nftId, agentAddress };
  }

  return {
    registered: false,
    agentAddress,
    hint: "Run `npm run register:agent` to register this agent with Self Agent ID (ERC-8004). Requires a one-time passport scan via the Self app.",
  };
}
