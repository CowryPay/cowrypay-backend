import {
  address as toAddress,
  createSolanaRpc,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendTransactionWithoutConfirmingFactory,
  lamports,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Signature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";
import { SolanaTreasuryLiquidityError } from "./adapter.js";
import { generateAndEncryptSolanaKeyPair, decryptSolanaSigner, getSolanaTreasurySigner } from "./solanaKms.js";

// Support contact shown to users when the treasury itself can't afford to
// fund a new deposit address — an ops problem, not something a retry fixes.
const SUPPORT_TELEGRAM_LINK = "https://t.me/+OV3fAjsqmrtlZmY8";

// Shared by both mints we support on Solana — USDC and USDT are both
// 6-decimal SPL tokens, confirmed live via getTokenSupply for the USDT
// mint before it was added (see env.ts's own comment on that address).
export const SOLANA_TOKEN_DECIMALS = 6;

// A new system account needs ~890_880 lamports to be rent-exempt; its USDC
// Associated Token Account needs ~2_039_280 more (Solana's own official
// exchange-integration guide). Rounded up with a small buffer on top of the
// system-account amount so the account can also afford one future sweep
// transaction's own fee without needing an immediate top-up — mirrors
// chains.ts's gasBufferThreshold reasoning for the EVM chains.
const SYSTEM_ACCOUNT_RENT_LAMPORTS = 1_000_000n;
const ATA_RENT_LAMPORTS = 2_100_000n;

const SOLANA_MINTS: Record<string, () => string | undefined> = {
  USDC: () => env.solanaUsdcMint,
  USDT: () => env.solanaUsdtMint,
};

// Replaces the old single-token requireSolanaUsdcMint — same "throw clearly,
// don't let a missing/unsupported token silently resolve to nothing" stance,
// now keyed by symbol so USDT support is additive rather than a special case.
export function getSolanaMint(tokenSymbol: string): string {
  const resolver = SOLANA_MINTS[tokenSymbol.toUpperCase()];
  if (!resolver) {
    throw new Error(`${tokenSymbol} is not supported on Solana (supported: ${Object.keys(SOLANA_MINTS).join(", ")})`);
  }
  const mint = resolver();
  if (!mint) {
    throw new Error(`SOLANA_${tokenSymbol.toUpperCase()}_MINT must be set for Solana support`);
  }
  return mint;
}

// Pure string-based decimal-to-base-units conversion, deliberately not
// Number(amount) * 10**decimals — this codebase avoids floating-point
// arithmetic for money everywhere else (see utils/format.ts's own comment
// on the same concern) and there's no reason for Solana amounts to be the
// exception.
function parseTokenAmountToBaseUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const paddedFrac = (frac + "0".repeat(SOLANA_TOKEN_DECIMALS)).slice(0, SOLANA_TOKEN_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(SOLANA_TOKEN_DECIMALS) + BigInt(paddedFrac || "0");
}

function rpcClient() {
  return createSolanaRpc(env.solanaRpcUrl);
}

// Exported for crossChainSend/service.ts's just-in-time sweep backstop — the
// Solana-source analog of readTokenBalance (depositSweeper.ts) checking the
// EVM payout wallet before a bridge call, since the treasury's own ATA is
// what a Solana-source cross-chain send actually spends from (see
// solanaDepositSweeper.ts's withdraw()/sweepWallet, both treasury-funded).
// Returns 0n rather than throwing when the ATA doesn't exist yet (e.g. a
// mint the treasury has never received), matching sweepWallet's own
// getTokenAccountBalance().catch(() => null) treatment of the same case.
export async function readSolanaTreasuryBalance(tokenSymbol: string): Promise<bigint> {
  const rpc = rpcClient();
  const treasury = await getSolanaTreasurySigner();
  const treasuryOwner = toAddress(treasury.address);
  const mint = toAddress(getSolanaMint(tokenSymbol));
  const [treasuryAta] = await findAssociatedTokenPda({ owner: treasuryOwner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const balanceResult = await rpc.getTokenAccountBalance(treasuryAta).send().catch(() => null);
  return balanceResult ? BigInt(balanceResult.value.amount) : 0n;
}

const CONFIRM_POLL_INTERVAL_MS = 2_000;
const CONFIRM_REBROADCAST_INTERVAL_MS = 5_000;

// HTTP-only replacement for @solana/kit's sendAndConfirmTransactionFactory.
// That factory confirms via a WebSocket signatureSubscribe push, which
// returns a hard "-32601 Method not found" against our Alchemy endpoint in
// production (reproduced directly against the raw WS URL — an Alchemy
// app/account-level gap, not something fixable from our code). HTTP RPC
// calls against the same endpoint have been reliable all session, so this
// polls getSignatureStatuses instead of subscribing, rebroadcasting the
// transaction periodically in case the original send was dropped — the
// same "don't let a single naive send risk a silently-lost transfer"
// property the factory provided, just over HTTP.
async function confirmByPolling(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature,
  lastValidBlockHeight: bigint,
  rebroadcast: () => Promise<void>,
): Promise<void> {
  let lastBroadcastAt = 0;
  for (;;) {
    const now = Date.now();
    if (now - lastBroadcastAt >= CONFIRM_REBROADCAST_INTERVAL_MS) {
      await rebroadcast().catch(() => {}); // already-landed txs just no-op on resend
      lastBroadcastAt = now;
    }

    const {
      value: [status],
    } = await rpc.getSignatureStatuses([signature]).send();
    if (status) {
      if (status.err) {
        throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
    }

    const blockHeight = await rpc.getBlockHeight().send();
    if (blockHeight > lastValidBlockHeight) {
      throw new Error("Solana transaction expired before confirmation (blockhash no longer valid)");
    }

    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_INTERVAL_MS));
  }
}

// Solana transactions can be silently dropped and become permanently
// unlandable once their blockhash expires (~60-90s) — a materially
// different failure mode from EVM's nonce-based retries or Stellar's
// synchronous submit. confirmByPolling rebroadcasts on an interval until
// either confirmed or the blockhash expires, instead of a single naive
// send — using a bare send here would risk exactly the "money left the
// treasury, transaction never landed, no error surfaced" bug class this is
// meant to avoid.
// Exported for solanaDepositSweeper.ts's reuse — building/signing/sending a
// Solana transaction with the blockhash-expiry-safe send helper is exactly
// the same mechanics whether the fee payer is the treasury or a user's own
// decrypted signer.
export async function signAndSendTransaction(
  feePayer: Awaited<ReturnType<typeof getSolanaTreasurySigner>>,
  instructions: readonly unknown[],
): Promise<string> {
  const rpc = rpcClient();
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions as never, m),
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);

  const sendWithoutConfirming = sendTransactionWithoutConfirmingFactory({ rpc });
  await confirmByPolling(rpc, signature, latestBlockhash.lastValidBlockHeight, () =>
    // Kit's pipe-based builder can't narrow the transaction's lifetime type
    // down to specifically "blockhash lifetime" without much more verbose
    // generic annotations on every step above — it genuinely has one here
    // (setTransactionMessageLifetimeUsingBlockhash was used, not a durable
    // nonce), so this cast reflects a real runtime guarantee, not a bypass.
    sendWithoutConfirming(signedTx as never, { commitment: "confirmed" }),
  );
  return signature;
}

// Best-effort — never blocks or fails wallet creation. Keeps the existing
// Helius webhook's accountAddresses in sync as new wallets are created, so
// a new user's deposits are actually detected without anyone remembering
// to register them by hand. A fuller, self-healing periodic-reconciliation
// job (re-derive the full watch-list from the DB on an interval) is the
// more robust long-term design; this synchronous append is the minimal
// version that covers the common case for now.
async function registerSolanaWebhookAddress(address: string): Promise<void> {
  if (!env.heliusApiKey || !env.heliusWebhookId) return;
  try {
    const base = `https://mainnet.helius-rpc.com/v0/webhooks/${env.heliusWebhookId}`;
    const getRes = await fetch(`${base}?api-key=${env.heliusApiKey}`);
    if (!getRes.ok) throw new Error(`GET webhook failed (${getRes.status}): ${await getRes.text()}`);
    const current = (await getRes.json()) as {
      webhookURL?: string;
      accountAddresses?: string[];
      transactionTypes?: string[];
      webhookType?: string;
      authHeader?: string;
    };
    const addresses = current.accountAddresses ?? [];
    if (addresses.includes(address)) return; // already watched, nothing to do

    // Real incident this closes: Helius's GET response includes read-only
    // metadata fields (webhookID, project, wallet) that its PUT endpoint
    // rejects outright if echoed back — spreading the full GET response
    // into the PUT body (the original version of this function did
    // exactly that) meant EVERY call here failed with a 400, silently,
    // since the feature was added. 26 of 27 production Solana wallets
    // never actually got registered. Only send the fields PUT actually
    // accepts, explicitly, not a spread of whatever GET happened to return.
    const putRes = await fetch(`${base}?api-key=${env.heliusApiKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhookURL: current.webhookURL,
        transactionTypes: current.transactionTypes,
        webhookType: current.webhookType,
        authHeader: current.authHeader,
        accountAddresses: [...addresses, address],
      }),
    });
    if (!putRes.ok) throw new Error(`PUT webhook failed (${putRes.status}): ${await putRes.text()}`);
  } catch (err) {
    console.error(`[solana-adapter] failed to register ${address} with Helius webhook:`, err);
  }
}

// Solana's own official exchange-integration guide recommends a unique
// deposit account per user — the opposite of Stellar's shared address, and
// much closer to how the EVM self-custody chains already work here. Unlike
// every other chain, a freshly-generated address is NOT immediately
// deposit-ready: it needs SOL for rent-exemption and a created Associated
// Token Account per token before it can actually receive it, so
// createWallet pre-funds the address itself plus USDC's ATA — USDC is the
// default/advertised token on Solana (buildSolanaAddressMessage only ever
// tells a user to send USDC). USDT's ATA is deliberately NOT created here
// anymore: every signup was paying ~2.1M lamports for a USDT ATA that the
// large majority of users, who never touch USDT, never used — see
// ensureSolanaUsdtAta below for the lazy on-demand equivalent, which must
// be called before any product surface tells a user their Solana address
// accepts USDT (skipping that would let a USDT deposit silently fail for
// senders whose own wallet doesn't auto-create the destination ATA).
async function fundAndCreateAta(
  owner: ReturnType<typeof toAddress>,
  address: string,
  mint: ReturnType<typeof toAddress>,
  solLamports: bigint,
): Promise<void> {
  const treasury = await getSolanaTreasurySigner();
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const transferIx = getTransferSolInstruction({ source: treasury, destination: owner, amount: lamports(solLamports) });
  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: treasury, ata, owner, mint });

  try {
    await signAndSendTransaction(treasury, [transferIx, createAtaIx]);
  } catch (err) {
    // Seen live: treasury runs low on SOL and the preflight simulation
    // rejects the transfer with "insufficient lamports X, need Y" in its
    // logs (RPC code -32002) — every route/chat layer above this just
    // relays err.message verbatim, so the fix has to happen right here,
    // at the one place that actually knows why this failed.
    if (
      isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE) &&
      err.context.logs?.some((line) => line.includes("insufficient lamports"))
    ) {
      console.error(`[solana-adapter] treasury ${treasury.address} is too low on SOL to fund ${address}'s ATA — needs topping up.`, err.context.logs);
      throw new SolanaTreasuryLiquidityError(
        `We're temporarily unable to set up your Solana deposit address due to a system issue on our end. ` +
          `Please reach out to our Telegram community and we'll get this sorted for you: ${SUPPORT_TELEGRAM_LINK}`,
      );
    }
    throw err;
  }
}

// Lazy, idempotent counterpart to createWallet's eager USDC-only funding —
// call this once, before any reply/response tells a user their existing
// Solana address accepts USDT (chat's deposit-chain flow, GET
// /wallets/solana?token=USDT, or any future surface). Safe to call more
// than once for the same address: getCreateAssociatedTokenIdempotentInstructionAsync
// no-ops on an ATA that already exists, so a second call just re-sends a
// SOL transfer the account didn't need — cheap, and still correct, but
// callers should still avoid calling it on every single message/request.
export async function ensureSolanaUsdtAta(address: string): Promise<void> {
  const owner = toAddress(address);
  const usdtMint = toAddress(getSolanaMint("USDT"));
  await fundAndCreateAta(owner, address, usdtMint, ATA_RENT_LAMPORTS);
}

export const solanaWalletAdapter: WalletAdapter = {
  async createWallet({ userId }): Promise<CreatedWallet> {
    void userId; // no per-user tagging mechanism analogous to KMS key tags here — the wallets row itself is the record
    const { address, ciphertext } = await generateAndEncryptSolanaKeyPair();
    const usdcMint = toAddress(getSolanaMint("USDC"));
    const owner = toAddress(address);

    await fundAndCreateAta(owner, address, usdcMint, SYSTEM_ACCOUNT_RENT_LAMPORTS + ATA_RENT_LAMPORTS);

    await registerSolanaWebhookAddress(address);

    return { externalWalletId: ciphertext, address, chain: "solana" };
  },

  // Mirrors awsKmsAdapter.withdraw's single-payout-key shape exactly (never
  // per-user signing) — pays out from the treasury's own USDC ATA. Also
  // idempotently creates the *destination's* ATA if it doesn't exist yet,
  // paid for by the treasury, in the same transaction — unlike our own
  // new user wallets (pre-funded at createWallet time), an arbitrary
  // external withdraw destination is never guaranteed to already have USDC
  // support set up, and this codebase has no control over that.
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    const mint = getSolanaMint(input.tokenSymbol);
    const treasury = await getSolanaTreasurySigner();
    const treasuryOwner = toAddress(treasury.address);
    const destinationOwner = toAddress(input.toAddress);

    const [treasuryAta] = await findAssociatedTokenPda({
      owner: treasuryOwner,
      mint: toAddress(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destinationAta] = await findAssociatedTokenPda({
      owner: destinationOwner,
      mint: toAddress(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const createDestinationAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: treasury,
      ata: destinationAta,
      owner: destinationOwner,
      mint: toAddress(mint),
    });
    // The treasury's OWN (source) ATA was never idempotently created
    // anywhere for USDC either — it happened to already exist from manual
    // bootstrapping when Solana support first launched. USDT's is genuinely
    // new and has no such history, so this closes that gap for real rather
    // than relying on another one-off manual step: a no-op (idempotent,
    // same as the destination's above) once it exists, self-heals on the
    // very first USDT withdraw/fee-sweep if it doesn't yet.
    const createTreasuryAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: treasury,
      ata: treasuryAta,
      owner: treasuryOwner,
      mint: toAddress(mint),
    });

    // TransferChecked validates mint+decimals explicitly, unlike the plain
    // Transfer instruction — worth the one extra field given a wrong-
    // decimals bug elsewhere would otherwise be silently misinterpreted
    // rather than rejected outright.
    const transferIx = getTransferCheckedInstruction({
      source: treasuryAta,
      mint: toAddress(mint),
      destination: destinationAta,
      authority: treasury,
      amount: parseTokenAmountToBaseUnits(input.amount),
      decimals: SOLANA_TOKEN_DECIMALS,
    });

    // Deliberate synchronous-confirm stance, same as the Stellar adapter —
    // sendAndConfirmTransactionFactory only returns once the transaction
    // has actually landed (or the blockhash expired and it never will).
    // Do not "fix" this into the EVM adapter's broadcast-and-move-on
    // pattern; the reasoning that made that safe there (avoiding the
    // double-spend bug from treating pending-as-failure) doesn't carry
    // over the same way here.
    const signature = await signAndSendTransaction(treasury, [createTreasuryAtaIx, createDestinationAtaIx, transferIx]);
    return { txHash: signature, status: "CONFIRMED" };
  },
};

// Exported for the (Phase 4) sweeper's use — decrypts a specific user's
// signer to sign their own outbound sweep transaction, distinct from the
// treasury signer withdraw() uses.
export { decryptSolanaSigner };
