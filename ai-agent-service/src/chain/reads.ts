import type { PublicClient } from "viem";
import {
  groupRegistryContract,
  cowrypayContract,
  userRegistryContract,
} from "../abi/index.js";
import { normalizeUsernameForRegistry } from "./normalizeUsername.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const NAME_REGISTERED_EVENT = {
  type:   "event",
  name:   "NameRegistered",
  inputs: [
    { type: "address", name: "owner",    indexed: true  },
    { type: "bytes32", name: "nameHash", indexed: true  },
    { type: "string",  name: "name",     indexed: false },
  ],
} as const;

/**
 * Fetch the registered username for a wallet address.
 *
 * Strategy (most reliable to least):
 * 1. `ownerToName` contract read → if zero hash the wallet isn't registered at all.
 * 2. `NameRegistered` event scan with progressively smaller block windows to work
 *    around RPC providers that cap eth_getLogs range (e.g. 10 000 blocks).
 *
 * Returns null if the address has no registered username OR if the name string
 * couldn't be retrieved from events (caller should fall back to asking the user).
 */
export async function getRegisteredUsernameForAddress(
  client: PublicClient,
  wallet: `0x${string}`,
): Promise<string | null> {
  // Step 1 — fast contract read: is this wallet registered at all?
  let nameHash: `0x${string}`;
  try {
    nameHash = (await client.readContract({
      address:      userRegistryContract.address,
      abi:          userRegistryContract.abi,
      functionName: "getNameHashByAddress",
      args:         [wallet],
    })) as `0x${string}`;
  } catch (err) {
    console.warn("getNameHashByAddress failed:", (err as Error).message);
    return null;
  }
  if (nameHash === ZERO_HASH) return null; // definitely not registered

  // Step 2 — wallet IS registered; fetch the name string from event logs.
  // Try progressively smaller windows to avoid RPC block-range limits.
  let currentBlock: bigint;
  try { currentBlock = await client.getBlockNumber(); }
  catch { currentBlock = 99_999_999n; }

  const windows: bigint[] = [currentBlock, 50_000n, 10_000n, 2_000n];
  for (const window of windows) {
    const fromBlock = window >= currentBlock ? 0n : currentBlock - window;
    try {
      const logs = await client.getLogs({
        address:   userRegistryContract.address,
        event:     NAME_REGISTERED_EVENT,
        args:      { owner: wallet },
        fromBlock,
        toBlock:   "latest",
      });
      if (logs.length > 0) {
        return (logs.at(-1)!.args as { name?: string }).name ?? null;
      }
    } catch (err) {
      console.warn(`getLogs fromBlock=${fromBlock} failed:`, (err as Error).message);
      // try next (smaller) window
    }
  }

  // Contract says registered but we couldn't get the name string from events.
  // Signal this with a sentinel so the caller can ask the user to confirm their username.
  console.warn(`Wallet ${wallet} is registered on-chain but name string not retrievable from events.`);
  return "REGISTERED_UNKNOWN";
}

export async function isWalletRegisteredOnChain(
  client: PublicClient,
  wallet: `0x${string}`,
): Promise<boolean> {
  const hash = (await client.readContract({
    address: userRegistryContract.address,
    abi: userRegistryContract.abi,
    functionName: "getNameHashByAddress",
    args: [wallet],
  })) as `0x${string}`;
  return hash !== ZERO_HASH;
}

export async function readUsdmAddress(
  client: PublicClient,
): Promise<`0x${string}`> {
  const addr = await client.readContract({
    address: cowrypayContract.address,
    abi: cowrypayContract.abi,
    functionName: "usdm",
  });
  return addr as `0x${string}`;
}

/** CowryPay payment token (USDm) — alias used by webhook and scripts. */
export const readUsdcAddress = readUsdmAddress;

export async function resolveUsernameOnChain(
  client: PublicClient,
  handle: string,
): Promise<
  | { ok: true; username: string; address: `0x${string}` }
  | { ok: false; username: string; reason: string }
> {
  const norm = normalizeUsernameForRegistry(handle);
  if (!norm.ok) {
    return {
      ok: false,
      username: handle.replace(/^@/, "").toLowerCase(),
      reason: norm.reason,
    };
  }
  const addr = (await client.readContract({
    address: userRegistryContract.address,
    abi: userRegistryContract.abi,
    functionName: "getAddressByName",
    args: [norm.name],
  })) as `0x${string}`;
  if (addr === ZERO) {
    return {
      ok: false,
      username: norm.name,
      reason: "Name is not registered on-chain.",
    };
  }
  return { ok: true, username: norm.name, address: addr };
}

export async function resolveGroupByNameOnChain(
  client: PublicClient,
  wallet: `0x${string}`,
  searchName: string,
): Promise<
  | {
      ok: true;
      kind: "onchain";
      groupId: bigint;
      displayName: string;
      members: `0x${string}`[];
    }
  | { ok: false; reason: string }
> {
  const target = searchName.trim().toLowerCase().replace(/\bgroup\b/gi, "").trim();

  const owned = (await client.readContract({
    address: groupRegistryContract.address,
    abi: groupRegistryContract.abi,
    functionName: "getGroupsOwnedBy",
    args: [wallet],
  })) as readonly bigint[];
  const memberOf = (await client.readContract({
    address: groupRegistryContract.address,
    abi: groupRegistryContract.abi,
    functionName: "getGroupsForMember",
    args: [wallet],
  })) as readonly bigint[];

  const seen = new Set<string>();
  const ids: bigint[] = [];
  for (const id of [...owned, ...memberOf]) {
    const k = id.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    ids.push(id);
  }

  for (const id of ids) {
    const g = (await client.readContract({
      address: groupRegistryContract.address,
      abi: groupRegistryContract.abi,
      functionName: "getGroup",
      args: [id],
    })) as readonly [`0x${string}`, string, boolean];
    const [, name, active] = g;
    if (!active) continue;
    if (name.toLowerCase() !== target) continue;

    const members = (await client.readContract({
      address: groupRegistryContract.address,
      abi: groupRegistryContract.abi,
      functionName: "getMembers",
      args: [id],
    })) as readonly `0x${string}`[];
    if (members.length === 0) {
      return {
        ok: false,
        reason: `Group "${name}" has no members yet. Add members before paying.`,
      };
    }
    return {
      ok: true,
      kind: "onchain" as const,
      groupId: id,
      displayName: name,
      members: [...members],
    };
  }

  return {
    ok: false,
    reason: `No active group named "${searchName}" for your wallet. Create one or join it first.`,
  };
}

export async function formatGroupsLinesForWallet(
  client: PublicClient,
  wallet: `0x${string}`,
): Promise<string> {
  const owned = (await client.readContract({
    address: groupRegistryContract.address,
    abi: groupRegistryContract.abi,
    functionName: "getGroupsOwnedBy",
    args: [wallet],
  })) as readonly bigint[];
  const memberOf = (await client.readContract({
    address: groupRegistryContract.address,
    abi: groupRegistryContract.abi,
    functionName: "getGroupsForMember",
    args: [wallet],
  })) as readonly bigint[];

  const seen = new Set<string>();
  const ids: bigint[] = [];
  for (const id of [...owned, ...memberOf]) {
    const k = id.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    ids.push(id);
  }

  if (ids.length === 0) {
    return "No groups found for this wallet. Create one on-chain (GroupRegistry.createGroup).";
  }

  const lines: string[] = [];
  for (const id of ids) {
    const g = (await client.readContract({
      address: groupRegistryContract.address,
      abi: groupRegistryContract.abi,
      functionName: "getGroup",
      args: [id],
    })) as readonly [`0x${string}`, string, boolean];
    const [owner, name, active] = g;
    const members = (await client.readContract({
      address: groupRegistryContract.address,
      abi: groupRegistryContract.abi,
      functionName: "getMembers",
      args: [id],
    })) as readonly `0x${string}`[];
    const role =
      owner.toLowerCase() === wallet.toLowerCase() ? "owner" : "member";
    lines.push(
      `• id ${id} — "${name}" (${active ? "active" : "inactive"}, ${role}, ${members.length} payee(s))`,
    );
  }
  return `Your groups:\n${lines.join("\n")}`;
}
