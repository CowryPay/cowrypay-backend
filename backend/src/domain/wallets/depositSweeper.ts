import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { env } from "../../config/env.js";
import { walletsRepo } from "./repository.js";
import { kmsAccountFromKey, getWalletAddress } from "./awsKmsAdapter.js";
import { getReceiptStatus } from "./receiptStatus.js";
import { getChainConfig, getTokenConfig, SUPPORTED_CHAINS, MIN_SWEEP_TOKEN_AMOUNT } from "./chains.js";
import { claimNonce, resyncNonce, isNonceError, fetchPendingNonce } from "./evmNonce.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const TOPUP_CONFIRM_ATTEMPTS = 10;
const TOPUP_CONFIRM_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SweepablePayout {
  keyArn: string;
  address: `0x${string}`;
}

export interface SweepableWallet {
  externalWalletId: string;
  address: string;
}

// Shared with offramp/service.ts's and cryptoWithdrawals/service.ts's
// just-in-time sweep checks — same ABI, same "read a token balance" need,
// kept here instead of duplicated since this file already owns the ERC20
// ABI for the sweep transfer itself.
export async function readTokenBalance(chain: string, tokenSymbol: string, address: `0x${string}`): Promise<bigint> {
  const { viemChain, rpcUrl } = getChainConfig(chain);
  const { address: tokenAddress } = getTokenConfig(chain, tokenSymbol);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  return publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [address] });
}

// Kept separate from the listByProvider/DB orchestration below so it can be
// exercised directly against a real wallet without needing a live DB row —
// mirrors how receiptStatus.ts's getReceiptStatus was kept independent in
// Phase 3. Returns true if a sweep was attempted (broadcast), false if
// skipped (below dust threshold, or the gas top-up never confirmed).
export async function sweepWallet(
  chain: string,
  tokenSymbol: string,
  wallet: SweepableWallet,
  payout: SweepablePayout,
): Promise<boolean> {
  const { viemChain, rpcUrl, gasTopUpAmount, gasBufferThreshold } = getChainConfig(chain);
  const { address: tokenAddress } = getTokenConfig(chain, tokenSymbol);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const address = wallet.address as `0x${string}`;

  const tokenBalance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  if (tokenBalance < MIN_SWEEP_TOKEN_AMOUNT) return false;

  const nativeBalance = await publicClient.getBalance({ address });
  if (nativeBalance < gasBufferThreshold) {
    const payoutAccount = kmsAccountFromKey(payout.keyArn, payout.address);
    const payoutWalletClient = createWalletClient({ account: payoutAccount, chain: viemChain, transport: http(rpcUrl) });
    // Shares evmNonce.ts's cache with awsKmsAdapter.ts's withdraw() — both
    // send from this same payout wallet, and a sweep cycle can top up gas
    // for several wallets back-to-back, so this is exactly as exposed to
    // the same nonce-collision bug that broke every fee sweep after the
    // Alchemy RPC switch (see evmNonce.ts's own comment for the full
    // incident). A separate, file-local nonce cache here would just
    // recreate that bug between this function and withdraw().
    const fetchFreshNonce = fetchPendingNonce(viemChain, rpcUrl, payout.address);
    // Cross-process safety net, same lock key awsKmsAdapter.ts's withdraw()
    // uses for this same payout wallet — see advisoryLock.ts's own comment.
    const topUpHash: `0x${string}` = await withAdvisoryLock(`evm-nonce:${chain}`, async () => {
      try {
        const nonce = await claimNonce(chain, fetchFreshNonce);
        return await payoutWalletClient.sendTransaction({ to: address, value: gasTopUpAmount, nonce });
      } catch (err) {
        if (!isNonceError(err)) throw err;
        resyncNonce(chain);
        const freshNonce = await claimNonce(chain, fetchFreshNonce);
        return await payoutWalletClient.sendTransaction({ to: address, value: gasTopUpAmount, nonce: freshNonce });
      }
    });

    let confirmed = false;
    for (let attempt = 0; attempt < TOPUP_CONFIRM_ATTEMPTS; attempt++) {
      await sleep(TOPUP_CONFIRM_DELAY_MS);
      const status = await getReceiptStatus(chain, topUpHash);
      if (status === "success") {
        confirmed = true;
        break;
      }
      if (status === "reverted") break; // a plain value transfer reverting would be unexpected; fall through and skip
    }
    if (!confirmed) {
      // Nothing lost — the native token already sent (if any) is still at
      // the address, so next cycle proceeds straight to the sweep instead
      // of topping up again. Logged, though — this exact silent path
      // (return false, zero log output) was found live to be why a real
      // user's deposit sat unswept indefinitely with no error anywhere to
      // find: a top-up that never confirms just retries forever, invisibly.
      console.error(
        `[deposit-sweeper] gas top-up for ${address} on ${chain} (tx ${topUpHash}) didn't confirm within ${TOPUP_CONFIRM_ATTEMPTS * TOPUP_CONFIRM_DELAY_MS}ms — will retry next cycle.`,
      );
      return false;
    }
  }

  const account = kmsAccountFromKey(wallet.externalWalletId, address);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [payout.address, tokenBalance],
  });
  // Broadcast and move on — same stance as withdraw() (Phase 2): no
  // user-facing state depends on this confirming immediately, so there's
  // no double-spend-shaped risk here to guard against. A failed/stuck
  // sweep is simply reattempted next cycle.
  await walletClient.sendTransaction({ to: tokenAddress, data, value: 0n });
  return true;
}

// Moves each supported token from each user's own self-custody deposit
// address into the single payout key (see awsKmsAdapter.ts's withdraw()),
// on every supported chain (one KMS key derives one address valid on all
// of them — see chains.ts), so that key actually has funds to pay future
// sends out of. This has NO effect on user-facing balances — those are
// already correct the moment domain/deposits/stateMachine.ts credits the
// ledger (see depositScanner.ts) — it's a pure backend liquidity concern. A
// failed or stuck sweep degrades liquidity, it can never corrupt
// accounting, since it's purely a balance-check-driven, self-correcting
// process with nothing to track between runs (a successful sweep just
// drops the on-chain balance to ~0, so the next cycle naturally finds
// nothing to do there).
export async function sweepDeposits(): Promise<void> {
  const wallets = await walletsRepo.listByProvider("aws-kms");
  if (wallets.length === 0) return;

  if (!env.awsKmsPayoutKeyArn) {
    throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set when WALLET_PROVIDER=aws-kms");
  }
  const payoutKeyArn = env.awsKmsPayoutKeyArn;
  const payoutAddress = await getWalletAddress(payoutKeyArn);
  const payout: SweepablePayout = { keyArn: payoutKeyArn, address: payoutAddress };

  for (const chain of SUPPORTED_CHAINS) {
    const tokenSymbols = Object.keys(getChainConfig(chain).tokens);
    for (const wallet of wallets) {
      for (const tokenSymbol of tokenSymbols) {
        try {
          await sweepWallet(chain, tokenSymbol, wallet, payout);
        } catch (err) {
          console.error(`[deposit-sweeper] failed to sweep wallet ${wallet.id} on ${chain} (${tokenSymbol}):`, err);
        }
      }
    }
  }
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

// A complete no-op unless WALLET_PROVIDER=aws-kms is explicitly set — never
// the case on Railway/production today, so this never runs there.
export function startDepositSweeper(): void {
  if (env.walletProvider !== "aws-kms") return;
  setInterval(() => {
    sweepDeposits().catch((err) => console.error("[deposit-sweeper]", err));
  }, SWEEP_INTERVAL_MS);
}
