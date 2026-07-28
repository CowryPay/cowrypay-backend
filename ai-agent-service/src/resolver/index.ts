/**
 * Recipient resolver for the WhatsApp webhook flow.
 *
 * Resolves usernames from the on-chain UsernameRegistry (source of truth).
 * Groups are resolved from GroupRegistry on-chain.
 */
import { makePublicClient } from "../chain/client.js";
import {
  resolveUsernameOnChain,
  resolveGroupByNameOnChain,
} from "../chain/reads.js";
import type { User, Intent, ResolvedPayment } from "../types.js";

function getClient() {
  const rpc = process.env.MONAD_RPC_URL?.trim() || process.env.RPC_URL?.trim();
  if (!rpc) throw new Error("MONAD_RPC_URL is not set.");
  return makePublicClient(rpc, Number(process.env.MONAD_CHAIN_ID ?? 10143));
}

// ── Resolve a single username → { username, address } ────────────────────────
export async function resolveOne(
  raw: string,
): Promise<{ username: string; address: string }> {
  const client = getClient();
  const result = await resolveUsernameOnChain(client, raw);
  if (!result.ok) {
    throw new Error(
      `@${result.username} is not registered on CowryPay yet. Ask them to message this number to sign up.`,
    );
  }
  return { username: result.username, address: result.address };
}

// ── Resolve all recipients from an Intent ─────────────────────────────────────
export async function resolveRecipients(
  intent: Intent,
  sender: User,
): Promise<ResolvedPayment> {
  switch (intent.action) {
    case "SEND_SINGLE": {
      if (!intent.recipient) throw new Error("No recipient specified.");
      const r = await resolveOne(intent.recipient);
      const amount = intent.totalAmount ?? 0;
      return {
        recipients: [{ ...r, amount }],
        totalAmount: amount,
        note: intent.note,
      };
    }

    case "SPLIT_PAYMENT": {
      const names = intent.recipients;
      if (!names?.length) throw new Error("No recipients specified for split payment.");
      const total = intent.totalAmount ?? 0;
      const per = Math.round((total / names.length) * 100) / 100;

      const resolved = await Promise.all(names.map(resolveOne));
      return {
        recipients: resolved.map((r) => ({ ...r, amount: per })),
        totalAmount: total,
        note: intent.note,
      };
    }

    case "GROUP_PAYMENT": {
      if (!intent.groupName) throw new Error("No group name specified.");
      const client = getClient();
      const result = await resolveGroupByNameOnChain(
        client,
        sender.walletAddress as `0x${string}`,
        intent.groupName,
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      const total = intent.totalAmount ?? 0;
      const per = Math.round((total / result.members.length) * 100) / 100;
      return {
        recipients: result.members.map((addr) => ({
          username: addr,   // address used as display — confirmed on-chain
          address: addr,
          amount: per,
        })),
        totalAmount: total,
        groupId:   result.groupId,
        groupName: result.displayName,
      };
    }

    default:
      throw new Error(`Cannot resolve recipients for action: ${intent.action}`);
  }
}
