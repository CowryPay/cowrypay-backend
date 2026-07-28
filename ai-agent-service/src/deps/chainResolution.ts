import { cowrypayContract } from "../abi/index.js";
import { encodeCreateGroup } from "../chain/encodeGroupRegistry.js";
import { encodedCallToJson } from "../chain/encodeCowryPay.js";
import { makePublicClient } from "../chain/client.js";
import { encodeRegisterUsername } from "../chain/encodeUserRegistry.js";
import {
  formatGroupsLinesForWallet,
  isWalletRegisteredOnChain,
  resolveGroupByNameOnChain,
  resolveUsernameOnChain,
} from "../chain/reads.js";
import { normalizeUsernameForRegistry } from "../chain/normalizeUsername.js";
import type { EncodedTxJson, ResolutionDeps, TxMeta } from "./types.js";

export function createChainResolutionDeps(rpcUrl: string): ResolutionDeps {
  const chainId = Number(process.env.CHAIN_ID || 42220); // Celo mainnet
  const client = makePublicClient(rpcUrl, chainId);

  return {
    mode: "chain",
    publicClient: client,
    async isWalletRegistered(wallet) {
      if (!wallet) return false;
      return isWalletRegisteredOnChain(client, wallet);
    },
    resolveUsername: (handle) => resolveUsernameOnChain(client, handle),
    resolveGroupByName: (name, wallet) => {
      if (!wallet) {
        return Promise.resolve({
          ok: false,
          reason:
            "Pass walletAddress in the request body so we can find groups you own or belong to.",
        });
      }
      return resolveGroupByNameOnChain(client, wallet, name);
    },
    listGroups: (wallet) => {
      if (!wallet) {
        return Promise.resolve(
          "Pass walletAddress to list groups from GroupRegistry.",
        );
      }
      return formatGroupsLinesForWallet(client, wallet);
    },
    getMeta: async (): Promise<TxMeta> => ({
      chainId,
      cowryPay: cowrypayContract.address,
    }),
    adminCreateGroup: async (displayName: string, memberHandles: string[]) => {
      const trimmed = displayName.trim();
      if (!trimmed) {
        return { ok: false, reason: "Group name cannot be empty." };
      }
      const resolved: string[] = [];
      for (const h of memberHandles) {
        const r = await resolveUsernameOnChain(client, h);
        if (!r.ok) {
          return {
            ok: false,
            reason: `Cannot resolve @${r.username}: ${r.reason ?? "unknown"}`,
          };
        }
        resolved.push(`${r.username} → ${r.address}`);
      }
      const tx = encodeCreateGroup(trimmed);
      const transactions: EncodedTxJson[] = [encodedCallToJson(tx)];
      const memberNote =
        resolved.length > 0
          ? ` After the tx confirms, add members with GroupRegistry.addMember(groupId, address): ${resolved.join("; ")}.`
          : " After the tx confirms, add payees with GroupRegistry.addMember(groupId, address). Owner is not auto-added as a member.";
      return {
        ok: true,
        message: `Sign **createGroup** below. Note: the owner is not automatically a group member.${memberNote}`,
        transactions,
      };
    },
    async adminRegisterUsername(rawName: string, wallet) {
      const norm = normalizeUsernameForRegistry(rawName);
      if (!norm.ok) {
        return { ok: false, reason: norm.reason };
      }
      if (wallet) {
        const already = await isWalletRegisteredOnChain(client, wallet);
        if (already) {
          return {
            ok: false,
            reason:
              "This wallet already has a Cowry username on-chain (one name per address).",
          };
        }
      }
      const tx = encodeRegisterUsername(norm.name);
      return {
        ok: true,
        message: `Sign **register** with the wallet that should own @${norm.name}. After it confirms, others can pay you by name.`,
        transactions: [encodedCallToJson(tx)],
      };
    },
  };
}
