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
import { generateAndEncryptSolanaKeyPair, decryptSolanaSigner, getSolanaTreasurySigner } from "./solanaKms.js";

const USDC_DECIMALS = 6;

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
async function signAndSendTransaction(
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
    await signAndSendTransaction(treasury, [transferIx, createAtaIx]);

    return { externalWalletId: ciphertext, address, chain: "solana" };
  },

  // Phase 1 only ships wallet creation, inert otherwise — mirrors how the
  // Stellar and aws-kms self-custody work shipped in phases. See the
  // Solana integration plan for what's still missing (deposit detection,
  // sweep) before withdraw can be safely implemented and tested.
  async withdraw(_input: WithdrawInput): Promise<WithdrawResult> {
    throw new Error("Solana withdraw is not implemented yet (Phase 1 of the Solana integration)");
  },
};

// Exported for the (Phase 4) sweeper's use — decrypts a specific user's
// signer to sign their own outbound sweep transaction, distinct from the
// treasury signer withdraw() uses.
export { decryptSolanaSigner };
