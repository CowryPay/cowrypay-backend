import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";

export const mockWalletAdapter: WalletAdapter = {
  async createWallet(input: { userId: string; email: string | null }): Promise<CreatedWallet> {
    return {
      externalWalletId: `mock_${input.userId}`,
      address: `0x${randomBytes(20).toString("hex")}`,
      chain: env.defaultChain,
    };
  },

  async withdraw(_input: WithdrawInput): Promise<WithdrawResult> {
    return { txHash: `0xmock${randomBytes(16).toString("hex")}`, status: "PENDING" };
  },
};
