import {
  address as toAddress,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  lamports,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
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

export const USDC_DECIMALS = 6;

// A new system account needs ~890_880 lamports to be rent-exempt; its USDC
// Associated Token Account needs ~2_039_280 more (Solana's own official
// exchange-integration guide). Rounded up with a small buffer on top of the
// system-account amount so the account can also afford one future sweep
// transaction's own fee without needing an immediate top-up — mirrors
// chains.ts's gasBufferThreshold reasoning for the EVM chains.
const SYSTEM_ACCOUNT_RENT_LAMPORTS = 1_000_000n;
const ATA_RENT_LAMPORTS = 2_100_000n;

function requireSolanaUsdcMint(): string {
  if (!env.solanaUsdcMint) throw new Error("SOLANA_USDC_MINT must be set for Solana support");
  return env.solanaUsdcMint;
}

// Pure string-based decimal-to-base-units conversion, deliberately not
// Number(amount) * 10**decimals — this codebase avoids floating-point
// arithmetic for money everywhere else (see utils/format.ts's own comment
// on the same concern) and there's no reason for Solana amounts to be the
// exception.
function parseUsdcAmountToBaseUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const paddedFrac = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(paddedFrac || "0");
}

function rpcClients() {
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const wsUrl = env.solanaRpcUrl.replace(/^http/, "ws");
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  return { rpc, rpcSubscriptions };
}

// Solana transactions can be silently dropped and become permanently
// unlandable once their blockhash expires (~60-90s) — a materially
// different failure mode from EVM's nonce-based retries or Stellar's
// synchronous submit. sendAndConfirmTransactionFactory rebroadcasts on an
// interval until either confirmed or the blockhash expires, instead of a
// single naive send — using a bare send here would risk exactly the "money
// left the treasury, transaction never landed, no error surfaced" bug
// class this is meant to avoid.
// Exported for solanaDepositSweeper.ts's reuse — building/signing/sending a
// Solana transaction with the blockhash-expiry-safe send helper is exactly
// the same mechanics whether the fee payer is the treasury or a user's own
// decrypted signer.
export async function signAndSendTransaction(
  feePayer: Awaited<ReturnType<typeof getSolanaTreasurySigner>>,
  instructions: readonly unknown[],
): Promise<string> {
  const { rpc, rpcSubscriptions } = rpcClients();
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions } as never);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions as never, m),
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  // Kit's pipe-based builder can't narrow the transaction's lifetime type
  // down to specifically "blockhash lifetime" without much more verbose
  // generic annotations on every step above — it genuinely has one here
  // (setTransactionMessageLifetimeUsingBlockhash was used, not a durable
  // nonce), so this cast reflects a real runtime guarantee, not a bypass.
  await sendAndConfirm(signedTx as never, { commitment: "confirmed" });
  return getSignatureFromTransaction(signedTx);
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
    const current = (await getRes.json()) as { accountAddresses?: string[] };
    const addresses = current.accountAddresses ?? [];
    if (addresses.includes(address)) return; // already watched, nothing to do

    const putRes = await fetch(`${base}?api-key=${env.heliusApiKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...current, accountAddresses: [...addresses, address] }),
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
// deposit-ready: it needs SOL for rent-exemption and a created USDC
// Associated Token Account before it can actually receive USDC, so
// createWallet pre-funds both from the treasury before returning.
export const solanaWalletAdapter: WalletAdapter = {
  async createWallet({ userId }): Promise<CreatedWallet> {
    void userId; // no per-user tagging mechanism analogous to KMS key tags here — the wallets row itself is the record
    const { address, ciphertext } = await generateAndEncryptSolanaKeyPair();
    const mint = requireSolanaUsdcMint();

    const treasury = await getSolanaTreasurySigner();
    const owner = toAddress(address);
    const [ata] = await findAssociatedTokenPda({ owner, mint: toAddress(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });

    const transferIx = getTransferSolInstruction({
      source: treasury,
      destination: owner,
      amount: lamports(SYSTEM_ACCOUNT_RENT_LAMPORTS + ATA_RENT_LAMPORTS),
    });
    const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: treasury,
      ata,
      owner,
      mint: toAddress(mint),
    });

    // Must complete before returning — an address that exists but was
    // never pre-funded is exactly the failure mode this whole step exists
    // to prevent (an incoming USDC transfer to it could fail or behave
    // unpredictably depending on whether the sender's wallet happens to
    // auto-create the recipient's ATA, which nothing guarantees). Throwing
    // here is safe: ensureAccount/ensureStellarWallet's existing
    // retry-on-conflict pattern already handles "concurrent call created
    // this already" cleanly, so a hard failure just surfaces as a clean
    // retry, not a silently broken wallet.
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
        console.error(
          `[solana-adapter] treasury ${treasury.address} is too low on SOL to fund a new wallet — needs topping up.`,
          err.context.logs,
        );
        throw new SolanaTreasuryLiquidityError(
          `We're temporarily unable to set up your Solana deposit address due to a system issue on our end. ` +
            `Please reach out to our Telegram community and we'll get this sorted for you: ${SUPPORT_TELEGRAM_LINK}`,
        );
      }
      throw err;
    }

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
    if (input.tokenSymbol.toUpperCase() !== "USDC") {
      throw new Error(`solana withdraw only supports USDC right now (got tokenSymbol=${input.tokenSymbol})`);
    }
    const mint = requireSolanaUsdcMint();
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

    // TransferChecked validates mint+decimals explicitly, unlike the plain
    // Transfer instruction — worth the one extra field given a wrong-
    // decimals bug elsewhere would otherwise be silently misinterpreted
    // rather than rejected outright.
    const transferIx = getTransferCheckedInstruction({
      source: treasuryAta,
      mint: toAddress(mint),
      destination: destinationAta,
      authority: treasury,
      amount: parseUsdcAmountToBaseUnits(input.amount),
      decimals: USDC_DECIMALS,
    });

    // Deliberate synchronous-confirm stance, same as the Stellar adapter —
    // sendAndConfirmTransactionFactory only returns once the transaction
    // has actually landed (or the blockhash expired and it never will).
    // Do not "fix" this into the EVM adapter's broadcast-and-move-on
    // pattern; the reasoning that made that safe there (avoiding the
    // double-spend bug from treating pending-as-failure) doesn't carry
    // over the same way here.
    const signature = await signAndSendTransaction(treasury, [createDestinationAtaIx, transferIx]);
    return { txHash: signature, status: "CONFIRMED" };
  },
};

// Exported for the (Phase 4) sweeper's use — decrypts a specific user's
// signer to sign their own outbound sweep transaction, distinct from the
// treasury signer withdraw() uses.
export { decryptSolanaSigner };
