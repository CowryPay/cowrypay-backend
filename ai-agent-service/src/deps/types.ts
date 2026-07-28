import type { PublicClient } from "viem";
import type { EncodedTxJson } from "../types.js";

export type { EncodedTxJson };

export type ResolveUsernameResult =
  | { ok: true; username: string; address: `0x${string}` }
  | { ok: false; username: string; reason?: string };

export type ResolveGroupResult =
  | {
      ok: true;
      kind: "onchain";
      groupId: bigint;
      displayName: string;
      members: `0x${string}`[];
    }
  | {
      ok: true;
      kind: "mock";
      displayName: string;
      members: { username: string; address: `0x${string}` }[];
    }
  | { ok: false; reason: string };

export type TxMeta = {
  chainId: number;
  /** CowryPay contract address — used as the spender in token approvals */
  cowryPay: `0x${string}`;
};

export type ResolutionDeps = {
  mode: "mock" | "chain";
  publicClient: PublicClient | null;
  /** Whether this wallet already claimed a Cowry username on-chain / in mock. */
  isWalletRegistered(wallet: `0x${string}` | undefined): Promise<boolean>;
  resolveUsername(handle: string): Promise<ResolveUsernameResult>;
  resolveGroupByName(
    name: string,
    wallet: `0x${string}` | undefined,
  ): Promise<ResolveGroupResult>;
  listGroups(wallet: `0x${string}` | undefined): Promise<string>;
  getMeta(): Promise<TxMeta>;
  adminCreateGroup(
    displayName: string,
    memberHandles: string[],
  ): Promise<
    { ok: true; message: string; transactions?: EncodedTxJson[] } | { ok: false; reason: string }
  >;
  adminRegisterUsername(
    rawName: string,
    wallet: `0x${string}` | undefined,
  ): Promise<
    { ok: true; message: string; transactions?: EncodedTxJson[] } | { ok: false; reason: string }
  >;
};
