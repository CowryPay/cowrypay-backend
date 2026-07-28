import { cowrypayContract } from "../abi/index.js";
import {
  createGroup,
  isWalletRegisteredMock,
  registerMockUsername,
  resolveGroup,
  resolveUsername,
  type ResolverContext,
} from "../resolvers.js";
import { normalizeUsernameForRegistry } from "../chain/normalizeUsername.js";
import type { EncodedTxJson, ResolutionDeps, TxMeta } from "./types.js";

function normalizeGroupKey(name: string): string {
  return name.trim().toLowerCase().replace(/\bgroup\b/gi, "").trim();
}

export function createMockResolutionDeps(ctx: ResolverContext): ResolutionDeps {
  return {
    mode: "mock",
    publicClient: null,
    async isWalletRegistered(wallet) {
      if (!wallet) return true;
      return isWalletRegisteredMock(ctx, wallet);
    },
    async resolveUsername(handle: string) {
      const norm = normalizeUsernameForRegistry(handle);
      if (!norm.ok) {
        return {
          ok: false,
          username: handle.replace(/^@/, "").toLowerCase(),
          reason: norm.reason,
        };
      }
      const r = resolveUsername(ctx, norm.name);
      if (!r.ok) {
        return {
          ok: false,
          username: r.username,
          reason: "Unknown username (mock registry).",
        };
      }
      return { ok: true, username: r.username, address: r.address };
    },
    async resolveGroupByName(name: string, _wallet) {
      const g = resolveGroup(ctx, name);
      if (!g.ok) {
        return { ok: false, reason: `Unknown group "${name}" (mock).` };
      }
      const members: { username: string; address: `0x${string}` }[] = [];
      for (const u of g.members) {
        const r = resolveUsername(ctx, u);
        if (!r.ok) {
          return {
            ok: false,
            reason: `Group member @${r.username} not in mock registry.`,
          };
        }
        members.push({ username: r.username, address: r.address });
      }
      return {
        ok: true,
        kind: "mock",
        displayName: g.name,
        members,
      };
    },
    async listGroups(_wallet) {
      const names = [...ctx.groups.keys()];
      if (names.length === 0) {
        return "You have no groups yet (mock). Try: create group Friends with @tolu, @ada";
      }
      const lines = names.map((n) => {
        const m = ctx.groups.get(n) ?? [];
        return `• ${n}: ${m.map((u) => `@${u}`).join(", ")}`;
      });
      return `Your groups (mock):\n${lines.join("\n")}`;
    },
    async getMeta(): Promise<TxMeta> {
      const chainId = Number(process.env.CHAIN_ID || 42220);
      return {
        chainId,
        cowryPay: cowrypayContract.address,
      };
    },
    async adminCreateGroup(displayName: string, memberHandles: string[]) {
      const res = createGroup(ctx, displayName, memberHandles);
      if (!res.ok) {
        return { ok: false, reason: res.reason };
      }
      return {
        ok: true,
        message: `Group **${res.name}** created (mock) with ${res.members.map((u) => `@${u}`).join(", ")}.`,
      };
    },
    async adminRegisterUsername(rawName: string, wallet) {
      if (!wallet) {
        return {
          ok: false,
          reason:
            "Pass **walletAddress** so we can link your name to your wallet (mock mode).",
        };
      }
      const res = registerMockUsername(ctx, rawName, wallet);
      if (!res.ok) {
        return { ok: false, reason: res.reason };
      }
      return {
        ok: true,
        message: `Registered **@${res.username}** to your wallet (mock). You can send USDC and use groups.`,
      };
    },
  };
}
