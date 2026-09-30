import { createPublicClient, createWalletClient, http, encodeFunctionData, type PublicClient } from "viem";
import { env } from "../../config/env.js";
import { walletsRepo } from "./repository.js";
import { kmsAccountFromKey, getWalletAddress } from "./awsKmsAdapter.js";
import { getReceiptStatus } from "./receiptStatus.js";
import { getChainConfig, getTokenConfig, SUPPORTED_CHAINS, MIN_SWEEP_TOKEN_AMOUNT } from "./chains.js";
import { fetchPendingNonce, withClaimedNonce } from "./evmNonce.js";
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

// A real transfer() call on every chain this registry lists has been
// observed at 62-65k gas (see chains.ts's own comments) — rounded up for
// margin rather than trusting that exact figure to hold on every chain.
const SWEEP_GAS_LIMIT_ESTIMATE = 70_000n;
// Covers gas price moving between this estimate and the moment the
// deposit wallet actually broadcasts its own sweep transaction moments
// later — not a guess at "usually enough", since the estimate itself is
// already live.
const GAS_TOPUP_SAFETY_MULTIPLIER = 3n;
// Real incident (2026-09-18): every chain here used to have a fixed
// gasTopUpAmount constant in chains.ts (see that file's own comment on
// Ethereum's specifically) — calibrated once against an assumed gas
// price and never revisited. On Ethereum, the actual configured value
// was ~7x higher than even its own documented "cautious baseline" would
// require, and didn't scale DOWN when real gas was far cheaper than that
// baseline — silently sending ~$12 of unrecoverable dust into a user's
// own deposit wallet on every single top-up (the excess just sits there,
// spent on nothing), which is why the shared payout wallet kept running
// dry no matter how many times it was manually refunded. This replaces
// that fixed guess with a live one, computed fresh at the moment a
// wallet actually needs topping up — cheap when the network is cheap,
// and (unlike a static guess) automatically scales up during a real
// congestion spike instead of getting stuck on an outdated assumption.
//
// The floor and ceiling are derived from THIS chain's own
// gasBufferThreshold, not a shared absolute number — verified live before
// this shipped: a first version used one flat wei bound for every chain,
// which silently broke Celo (whose native token isn't priced anywhere
// near ETH) by clamping a correctly-computed ~0.05 CELO estimate down to
// an ETH-scaled 0.02, undershooting what Celo transfers actually cost by
// more than half. gasBufferThreshold is already calibrated per chain to
// that chain's own real order of magnitude (0.02 CELO vs 0.00003 ETH on
// the L2s vs 0.002 ETH on mainnet), so scaling off it keeps the floor/
// ceiling correctly chain-relative for free.
async function estimateGasTopUp(chain: string, publicClient: PublicClient): Promise<bigint> {
  const { gasBufferThreshold } = getChainConfig(chain);
  const fees = await publicClient.estimateFeesPerGas();
  const perGas = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  const estimate = SWEEP_GAS_LIMIT_ESTIMATE * perGas * GAS_TOPUP_SAFETY_MULTIPLIER;
  const min = gasBufferThreshold / 2n;
  const max = gasBufferThreshold * 10n;
  if (estimate < min) return min;
  if (estimate > max) return max;
  return estimate;
}

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

// A plain native value transfer to an EOA (the payout key) — confirmed
// live on Arc via eth_estimateGas (exactly 21,000), and fixed by the EVM
// itself for any EOA recipient, so pinned rather than re-estimated.
const NATIVE_TRANSFER_GAS = 21_000n;

// For a token that IS the chain's native gas token (Arc's USDC — see
// chains.ts's own entry): no payout top-up, since the wallet already holds
// its own gas in the very balance being swept, and a top-up would itself
// land as a native send into the user's address that depositScanner.ts
// credits as a deposit. Instead sends everything natively except a gas
// reserve, with maxFeePerGas pinned to the same live estimate that sized
// the reserve so the fee can never exceed it. The unused part of the
// reserve (~2/3 of it) just stays behind — smaller than the reserve the
// next cycle computes, so this never re-sweeps its own leftovers.
async function sweepNativeGasToken(chain: string, wallet: SweepableWallet, payout: SweepablePayout): Promise<boolean> {
  const { viemChain, rpcUrl, tokens, nativeToken } = getChainConfig(chain);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const address = wallet.address as `0x${string}`;
  const tokenDecimals = tokens[nativeToken!.symbol]!.decimals;
  const minSweep = MIN_SWEEP_TOKEN_AMOUNT * 10n ** BigInt(viemChain.nativeCurrency.decimals - tokenDecimals);

  const [balance, fees] = await Promise.all([publicClient.getBalance({ address }), publicClient.estimateFeesPerGas()]);
  const maxFeePerGas = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  const reserve = NATIVE_TRANSFER_GAS * maxFeePerGas * GAS_TOPUP_SAFETY_MULTIPLIER;
  const value = balance - reserve;
  if (value < minSweep) return false;

  const account = kmsAccountFromKey(wallet.externalWalletId, address);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
  await walletClient.sendTransaction({
    to: payout.address,
    value,
    gas: NATIVE_TRANSFER_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return true;
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
  const { viemChain, rpcUrl, nativeToken } = getChainConfig(chain);
  if (nativeToken?.symbol === tokenSymbol.toUpperCase()) return sweepNativeGasToken(chain, wallet, payout);
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
  const gasTopUpAmount = await estimateGasTopUp(chain, publicClient);
  // Compared against a FRESH estimate every cycle, not a fixed old
  // threshold — closes the exact stuck-forever bug chains.ts's own Celo
  // comment describes (a wallet topped up once sits above a static
  // threshold forever even after gas prices move, since nothing ever
  // re-checks against the new reality). Topping up whenever the balance
  // is under half of what's needed RIGHT NOW self-corrects on its own if
  // gas gets more expensive later.
  if (nativeBalance < gasTopUpAmount / 2n) {
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
    const topUpHash: `0x${string}` = await withAdvisoryLock(`evm-nonce:${chain}`, () =>
      withClaimedNonce(chain, fetchFreshNonce, (nonce) =>
        payoutWalletClient.sendTransaction({ to: address, value: gasTopUpAmount, nonce }),
      ),
    );

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
