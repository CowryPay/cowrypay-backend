import { randomUUID } from "node:crypto";
import { withTransaction, pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { lockedOrdersRepo } from "./lockedOrdersRepository.js";
import type { Send, SendRecipient } from "../../types.js";
import { usersRepo } from "../users/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { getWalletAdapter } from "../wallets/index.js";
import { PayoutLiquidityError } from "../wallets/adapter.js";
import { ledgerRepo } from "../ledger/repository.js";
import { canInitiateSend } from "../sendAuthorization.js";
import { verifyTransactionPin } from "../pin/service.js";
import { createOfframpOrder, type CreatedOrder } from "./paycrestAdapter.js";
import { createOfframpOrder as createQuidaxOrder } from "./quidaxAdapter.js";
import { createOfframpOrder as createCentiivOrder } from "./centiivAdapter.js";
import { computeFeeSplit, requireTreasuryAddress } from "./fee.js";
import { sendsRepo } from "./repository.js";
import { isPaycrestEligible, type OfframpProvider } from "./providerSelection.js";
import { getReceiptStatus } from "../wallets/receiptStatus.js";
import { readTokenBalance, sweepWallet } from "../wallets/depositSweeper.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getTokenConfig, SUPPORTED_CHAINS as EVM_CHAINS } from "../wallets/chains.js";
import { parseUnits } from "viem";
import { sanitizeForDb, formatAmount } from "../../utils/format.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONFIRM_POLL_INTERVAL_MS = 3_000;
const CONFIRM_MAX_ATTEMPTS = 20; // ~60s — comfortable margin over normal Base/Celo/Optimism confirmation times

// Self-broadcast EVM payouts (aws-kms) return immediately after
// broadcasting, before any confirmation — a deliberate design (see
// awsKmsAdapter.ts's own comment on avoiding a double-spend bug from
// waiting synchronously inside withdraw() itself). Real incident this
// closes: a payout's broadcast silently never reached the network at all
// (eth_getTransactionByHash returned null ~2 hours later), yet the send
// still moved to PAYOUT_INITIATED and the platform fee was swept as if it
// had succeeded — undetected until a user reported funds not arriving.
// Only meaningful for EVM chains reachable via getReceiptStatus; Stellar/
// Solana's own withdraw() already waits for real confirmation before
// returning at all, and Blockradar-custodied payouts confirm via their
// own webhook (routes/blockradarWebhook.ts), a different mechanism this
// doesn't need to duplicate.
async function waitForEvmPayoutConfirmation(chain: string, txHash: string): Promise<"success" | "reverted" | "unconfirmed"> {
  for (let attempt = 0; attempt < CONFIRM_MAX_ATTEMPTS; attempt++) {
    const status = await getReceiptStatus(chain, txHash);
    if (status === "success" || status === "reverted") return status;
    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }
  return "unconfirmed";
}

// Carried over from a chat draft (domain/chat/remittanceDraft.ts), which
// already locked a real rate/receive address (against the net amount, after
// fee) by creating this order up front — reused here instead of creating a
// second, redundant order.
export interface LockedOrder extends CreatedOrder {
  reference: string;
  feeAmount: string;
  treasuryAddress: string;
  // Which provider actually created this locked order — required now that
  // remittanceDraft.ts can lock either provider, not assumed to be Paycrest
  // the way it safely could be before (see the reuse fix below).
  provider: OfframpProvider;
  // Which token this order was actually quoted/created for — omitted means
  // USDC, matching every locked order created before USDT support existed.
  // Reusing a chat-locked order must debit the SAME token it was quoted
  // against, or the amounts would silently mean different things.
  tokenSymbol?: string;
}

export interface InitiateSendInput {
  amount: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  pin: string;
  rate?: string;
  existingOrder?: LockedOrder;
  // Which chain to pay this send out from — defaults to wallet.chain when
  // omitted, so any caller that doesn't pass it (old frontend, direct API
  // use) behaves exactly as before per-chain balances existed. Only
  // meaningful once a wallet can hold balance on more than one chain (see
  // the Phase 7 migration plan) — until then this is always "celo".
  chain?: string;
  // Which off-ramp provider to actually use — required to be explicit
  // (not auto-re-decided here) because `recipient.institution` is a
  // provider-specific bank code (Paycrest's own codes vs Quidax's CBN
  // codes are different namespaces) that the caller must already have
  // resolved via the matching provider's institution list. Omitted means
  // Paycrest — the only provider that existed before this, so every
  // caller that hasn't been updated to pass this keeps working exactly as
  // before. See providerSelection.ts for the rate-shopping step callers
  // are expected to run before this, to actually decide which provider
  // and institution list to use.
  provider?: OfframpProvider;
  // Omitted means USDC — the only token that existed before USDT support,
  // so every caller that hasn't been updated keeps working exactly as
  // before.
  tokenSymbol?: string;
}

export interface InitiatedSend {
  send: Send;
  receiveAddress: string;
  validUntil: string;
  // Friendly confirmation text for the frontend to show right after
  // submission. Deliberately says "processing", not "completed" — at this
  // point the send has only broadcast, not settled (Paycrest's own
  // payment_order.* webhook is what actually confirms that, later) —
  // claiming otherwise here would repeat the exact kind of premature
  // "done" claim that caused the double-spend bug earlier in this project.
  message: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// SEND_INSTRUCTED -> ORDER_CREATED -> PAYOUT_INITIATED. Compliance screening
// (mirroring domain/deposits/screening.ts) isn't wired yet, but the payout
// broadcast is: once Paycrest's order is created, the net amount is paid
// directly from Blockradar's master wallet (which every deposit lands in
// automatically via Blockradar's own auto-sweep — confirmed live, no code
// of ours involved) to the order's receiveAddress, and the platform fee is
// paid to treasury the same way — neither withdraws from the sending
// user's own Blockradar wallet. SETTLING/COMPLETE arrive later via the
// payment_order.* webhook once Paycrest confirms the deposit and completes
// the payout; PAYOUT_INITIATED itself may still be confirming on-chain —
// Blockradar's own withdraw.success/withdraw.failed webhook (see
// routes/blockradarWebhook.ts) is what would flip this to FAILED if a
// broadcast that looked accepted doesn't actually land.
export async function initiateSend(userId: string, input: InitiateSendInput): Promise<InitiatedSend> {
  const user = await usersRepo.findById(userId);
  if (!user) throw new Error("User not found");

  const authResult = canInitiateSend(user);
  if (!authResult.allowed) {
    throw new Error(`send not allowed: ${authResult.reason}`);
  }

  // Gates the actual fund movement below — checked before touching the
  // database or Paycrest, per the architecture rule that nothing moving real
  // funds can rely solely on an already-unlocked session (§9).
  const pinValid = await verifyTransactionPin(userId, input.pin);
  if (!pinValid) {
    throw new Error("Incorrect PIN");
  }

  // Real vulnerability closed here: input.existingOrder used to be trusted
  // directly — receiveAddress (where the real payout broadcasts to) and
  // treasuryAddress (where the platform fee sweeps to) came straight from
  // the request body, gated only by a client-controlled validUntil string.
  // Any authenticated user with a funded balance could fabricate an order
  // pointing both at their own wallet and skip Paycrest/Quidax/Centiiv
  // entirely. Only `.reference` is used now, to look up the SERVER-STORED
  // record of what was actually created with a real provider (see
  // lockedOrdersRepository.ts) — every field below comes from that record,
  // never from the client. This lookup alone doesn't authorize spending
  // anything yet; claim() inside the debit transaction below is what does.
  let lockedPreview = null as Awaited<ReturnType<typeof lockedOrdersRepo.findByReference>>;
  if (input.existingOrder?.reference) {
    lockedPreview = await lockedOrdersRepo.findByReference(input.existingOrder.reference, userId, pool);
    if (
      !lockedPreview ||
      lockedPreview.consumedAt ||
      new Date(lockedPreview.validUntil).getTime() <= Date.now()
    ) {
      throw new Error("This quote is no longer valid — please start a new send.");
    }
  }

  // Every EVM chain (celo/base/optimism) shares one wallet row, always
  // registered under env.defaultChain — one KMS/Blockradar address covers
  // all of them, so "which EVM chain to send from" (input.chain) and
  // "which wallet row to look up" are different questions there. Stellar
  // and Solana are both genuine exceptions: each has its own dedicated
  // wallet row, keyed under its own chain name. Mirrors
  // cryptoWithdrawals/service.ts's walletChainKeyFor exactly — this used
  // to only special-case "stellar", which meant a Solana send fetched the
  // user's EVM wallet row instead of their Solana one. That wrong `wallet`
  // was still only used for its `.provider` field further down (`chain`
  // itself came from effectiveChainInput, so routing was never wrong) —
  // but that provider field is now aws-kms for virtually every user after
  // the Blockradar cutover, which made `wallet.provider === "aws-kms"`
  // true for a Solana send too, wrongly triggering the EVM-only
  // post-payout confirmation wait below on a Solana chain — see that
  // block's own comment for what that produced live (2026-08-25, send
  // fa6e221f): a real, successful Solana payout reported to the user as
  // failed, because the confirmation check crashed on "solana" being an
  // unsupported EVM chain in chains.ts, after the money had already gone.
  const effectiveChainInput = lockedPreview?.chain ?? input.chain;
  const walletChainKey =
    effectiveChainInput?.toLowerCase() === "stellar"
      ? "stellar"
      : effectiveChainInput?.toLowerCase() === "solana"
        ? "solana"
        : env.defaultChain;
  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKey);
  if (!wallet) throw new Error("No wallet found for user");
  const chain = effectiveChainInput ?? wallet.chain;
  const walletAddress = wallet.address;

  // A reused chat-locked order must debit the same token (and amount —
  // see below) it was quoted against, so both come from the stored record,
  // never from the request body, once one exists. Validated for EVM chains
  // up front via chains.ts's token map (e.g. USDT on Base) so an
  // unsupported pairing fails clean, before any balance is touched.
  const tokenSymbol = lockedPreview?.tokenSymbol ?? input.tokenSymbol ?? env.defaultTokenSymbol;
  if (EVM_CHAINS.includes(chain.toLowerCase())) {
    getTokenConfig(chain, tokenSymbol);
  }
  const amount = lockedPreview?.amountHuman ?? input.amount;
  const reference = lockedPreview?.reference ?? randomUUID();

  // Recomputed fresh even when reusing a chat-locked order — computeFeeSplit
  // is a pure function of amount + the fee bps, so this reproduces the exact
  // net amount Paycrest's order was created with (LockedOrder doesn't carry
  // it directly) as long as the fee bps hasn't changed mid-quote-window.
  const { feeAmount, netAmount } = computeFeeSplit(amount);
  const treasuryAddress = lockedPreview?.treasuryAddress ?? (await requireTreasuryAddress(chain));

  const send = await withTransaction(async (client) => {
    // Claimed atomically alongside the debit below (not before it) so a
    // legitimate insufficient-balance retry — which rolls the whole
    // transaction back, claim included — still leaves the quote reusable.
    // Returns null if this reference was already consumed (a replay) or
    // never belonged to this user; either way, that's a hard stop, not
    // something to fall back to a fresh order for.
    if (lockedPreview) {
      const claimed = await lockedOrdersRepo.claim(client, lockedPreview.reference, userId);
      if (!claimed) {
        throw new Error("This quote was already used or is no longer valid — please start a new send.");
      }
    }

    // Atomic decrement-with-guard (see ledgerRepo.debitAvailable) — two
    // concurrent sends can't both pass a balance check and double-spend the
    // same funds; whichever commits first wins, the other sees the reduced
    // balance and fails here.
    const debited = await ledgerRepo.debitAvailable(client, userId, tokenSymbol, chain, amount);
    if (!debited) {
      throw new Error("Insufficient balance");
    }

    const created = await sendsRepo.create(client, {
      userId,
      walletId: wallet.id,
      tokenSymbol,
      chain,
      amountHuman: amount,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
      feeAmount,
      treasuryAddress,
    });
    await sendsRepo.logTransition(client, created.id, null, "SEND_INSTRUCTED", "send_requested");
    return created;
  });

  // A reused chat-locked order already carries the provider it was
  // actually created with (remittanceDraft.ts can lock either provider) —
  // a fresh order dispatches to whichever provider the caller explicitly
  // chose (see InitiateSendInput.provider's own comment on why this isn't
  // re-decided here).
  const provider: OfframpProvider = (lockedPreview?.provider as OfframpProvider | undefined) ?? input.provider ?? "paycrest";
  // Verified live: Paycrest structurally doesn't support Optimism/Solana/
  // Stellar at all (a hard "not supported" error, not a liquidity gap —
  // see paycrestAdapter.ts's own comment). A caller reaching here with
  // provider=paycrest (or no provider at all, defaulting to it) for one
  // of these chains would otherwise get Paycrest's own confusing raw
  // validation error instead of an honest one — callers are expected to
  // use GET /offramp/rate first to pick an eligible provider, but this is
  // the last line of defense if they don't.
  if (!lockedPreview && provider === "paycrest" && !isPaycrestEligible(chain, input.fiatCurrency)) {
    throw new Error(
      `Off-ramping from ${chain} isn't available via Paycrest — check GET /offramp/rate for which provider actually supports this chain.`,
    );
  }
  async function createOrderForProvider(): Promise<CreatedOrder> {
    const recipient = {
      institution: input.recipient.institution,
      accountIdentifier: input.recipient.accountIdentifier,
      accountName: input.recipient.accountName,
    };
    if (provider === "quidax") {
      return createQuidaxOrder({ amount: netAmount, network: chain, token: tokenSymbol, fiatCurrency: input.fiatCurrency, recipient, reference });
    }
    if (provider === "centiiv") {
      return createCentiivOrder({ amount: netAmount, network: chain, token: tokenSymbol, fiatCurrency: input.fiatCurrency, recipient, reference });
    }
    return createOfframpOrder({
      amount: netAmount,
      token: tokenSymbol,
      network: chain,
      refundAddress: walletAddress,
      fiatCurrency: input.fiatCurrency,
      recipient: input.recipient,
      reference,
      rate: input.rate,
    });
  }
  // Every field here — orderId, receiveAddress, validUntil, rate — comes
  // from the server-stored record when one exists, never from the client.
  const order: CreatedOrder = lockedPreview
    ? {
        orderId: lockedPreview.providerOrderId,
        receiveAddress: lockedPreview.receiveAddress,
        validUntil: lockedPreview.validUntil,
        rate: lockedPreview.rate,
      }
    : await createOrderForProvider();

  const updated = await withTransaction(async (client) => {
    const next = await sendsRepo.updateOrderCreated(client, send.id, {
      providerOrderId: order.orderId,
      rate: order.rate,
      provider,
    });
    await sendsRepo.logTransition(
      client,
      send.id,
      "SEND_INSTRUCTED",
      "ORDER_CREATED",
      lockedPreview ? "reused_chat_locked_order" : `${provider}_order_created`,
    );
    return next;
  });

  // Secondary backstop only, aws-kms EVM chains — the real, structural
  // fix is deposits/stateMachine.ts's triggerSweepAfterCredit, which
  // sweeps every deposit into the shared payout pool the instant it's
  // credited (matching how Blockradar's master wallet has auto-sweep
  // enabled), so liquidity for any user's off-ramp doesn't depend on
  // which specific user happens to have an unswept deposit at that
  // moment. This just covers the gap for anything credited before that
  // fix existed, or a case where that sweep attempt itself failed —
  // checks whether the shared payout wallet can cover this send and, if
  // not, makes one more attempt at sweeping the CURRENT user's own wallet
  // before falling through to withdraw()'s normal (accurate) liquidity
  // error. Does nothing for a shortfall bigger than this one user's own
  // deposit — that's correctly not this function's job.
  if (wallet.provider === "aws-kms" && EVM_CHAINS.includes(chain) && env.awsKmsPayoutKeyArn) {
    try {
      const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
      const { decimals: tokenDecimals } = getTokenConfig(chain, tokenSymbol);
      const needed = parseUnits(netAmount, tokenDecimals);
      const payoutBalance = await readTokenBalance(chain, tokenSymbol, payoutAddress);
      if (payoutBalance < needed) {
        console.log(
          `[offramp] payout wallet short on ${chain} for send ${updated.id} (have ${payoutBalance}, need ${needed}) — attempting just-in-time sweep of ${walletAddress}`,
        );
        const swept = await sweepWallet(
          chain,
          tokenSymbol,
          { externalWalletId: wallet.externalWalletId, address: walletAddress },
          { keyArn: env.awsKmsPayoutKeyArn, address: payoutAddress },
        );
        console.log(`[offramp] just-in-time sweep for send ${updated.id}: ${swept ? "broadcast" : "skipped (nothing to sweep, or gas top-up unconfirmed)"}`);

        // sweepWallet only broadcasts (same "broadcast and move on" stance
        // as withdraw() itself — see its own comment) — the very next step
        // here is attempting the payout, so unlike the periodic background
        // sweeper this needs to actually wait for the swept balance to
        // land, or the immediate retry below would just hit the same
        // shortfall again. Bounded wait, not indefinite: if it hasn't
        // landed by then, withdraw()'s own liquidity error is the honest
        // outcome.
        if (swept) {
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            const updatedBalance = await readTokenBalance(chain, tokenSymbol, payoutAddress);
            if (updatedBalance >= needed) break;
          }
        }
      }
    } catch (err) {
      // Best-effort — any failure here just falls through to the normal
      // withdraw() attempt below, which surfaces its own accurate
      // liquidity error if the sweep genuinely didn't help.
      console.error(`[offramp] just-in-time sweep check failed for send ${updated.id}:`, err);
    }
  }

  let payout;
  try {
    payout = await getWalletAdapter(chain, wallet.provider).withdraw({
      chain,
      tokenSymbol,
      toAddress: order.receiveAddress,
      amount: netAmount,
      reference: `${reference}-payout`,
    });
  } catch (err) {
    await withTransaction(async (client) => {
      // Refund — the balance was debited up front to prevent double-spending
      // across concurrent sends, but the payout never actually left custody,
      // so the user's balance shouldn't reflect otherwise. Credits back
      // `amount` (what was actually debited), not input.amount — the two
      // can differ when a locked order's own stored amount overrode it.
      await ledgerRepo.creditAvailable(client, userId, tokenSymbol, chain, amount);
      await sendsRepo.updateState(client, updated.id, { state: "FAILED" });
      // sanitizeForDb strips a raw NUL byte an error message can carry —
      // without it this logTransition call itself throws ("invalid byte
      // sequence for encoding UTF8: 0x00"), masking the real failure. See
      // utils/format.ts's own comment.
      await sendsRepo.logTransition(
        client,
        updated.id,
        "ORDER_CREATED",
        "FAILED",
        `blockradar_withdraw_failed: ${sanitizeForDb(err instanceof Error ? err.message : String(err))}`,
      );
    });
    // PayoutLiquidityError's message is already clean and accurate (our
    // payout wallet's liquidity, never the user's balance) — surfaced
    // as-is rather than wrapped in the generic "could not broadcast (raw
    // chain error)" text below, which is only fit for logs, not users.
    if (err instanceof PayoutLiquidityError) {
      throw err;
    }
    throw new Error(
      `Could not broadcast the payout (${err instanceof Error ? err.message : String(err)}) — the send was marked failed.`,
    );
  }

  // Closes the gap that let a Base payout's broadcast silently never
  // reach the network at all — undetected for ~2 hours, with the fee
  // swept as if it had succeeded, until a user reported funds not
  // arriving. Waits for a real on-chain outcome before this send is ever
  // treated as done. See waitForEvmPayoutConfirmation's own comment for
  // why this is scoped to aws-kms only. The explicit chain check is
  // deliberate, not redundant with wallet.provider === "aws-kms" alone —
  // that provider check was the exact gap that let this misfire on a
  // Solana send (see the walletChainKey comment above): `wallet` can, in
  // principle, be the wrong row again some other way in the future, but
  // `chain` itself is always correct (it's `effectiveChainInput`, never
  // derived from `wallet`), so gating on it too means this block can
  // never again run getReceiptStatus against a chain chains.ts doesn't
  // know, no matter what wallet.provider says.
  if (wallet.provider === "aws-kms" && EVM_CHAINS.includes(chain.toLowerCase()) && payout.txHash) {
    const confirmation = await waitForEvmPayoutConfirmation(chain, payout.txHash);

    if (confirmation === "reverted") {
      await withTransaction(async (client) => {
        await ledgerRepo.creditAvailable(client, userId, tokenSymbol, chain, amount);
        await sendsRepo.updateState(client, updated.id, { state: "FAILED", withdrawTxHash: payout.txHash });
        await sendsRepo.logTransition(
          client,
          updated.id,
          "ORDER_CREATED",
          "FAILED",
          `payout_reverted_onchain:${payout.txHash}`,
        );
      });
      throw new Error(
        "The payout transaction reverted on-chain — the send was marked failed and your balance was refunded.",
      );
    }

    if (confirmation === "unconfirmed") {
      // Deliberately NOT marked FAILED (it may still land later — the
      // Base incident's original broadcast never did, but that's not
      // guaranteed in general) and NOT credited back (same reason) — left
      // in ORDER_CREATED with a clear breadcrumb for manual follow-up
      // instead of guessing either way. Surfaces immediately in
      // /admin/sends as a non-terminal send, rather than silently
      // sweeping a fee for a payout nobody has verified actually happened.
      await withTransaction((client) =>
        sendsRepo.logTransition(
          client,
          updated.id,
          "ORDER_CREATED",
          "ORDER_CREATED",
          `payout_broadcast_unconfirmed:${payout.txHash}`,
        ),
      );
      throw new Error(
        `We're still waiting for your transfer to confirm on-chain — this needs a quick manual check before it can complete. Please contact support with reference ${reference}.`,
      );
    }
  }

  const final = await withTransaction(async (client) => {
    const next = await sendsRepo.updateState(client, updated.id, {
      state: "PAYOUT_INITIATED",
      withdrawTxHash: payout.txHash,
    });
    await sendsRepo.logTransition(
      client,
      updated.id,
      "ORDER_CREATED",
      "PAYOUT_INITIATED",
      payout.txHash
        ? "blockradar_withdraw_broadcast"
        : "blockradar_withdraw_broadcast_pending_screening",
    );
    return next;
  });

  // Best-effort — the user's payout already succeeded above, so a failure
  // here only means the platform fee didn't reach treasury this time, not
  // that the send itself failed. Logged for later manual reconciliation
  // rather than thrown.
  if (Number(feeAmount) > 0) {
    try {
      const feeSweep = await getWalletAdapter(chain, wallet.provider).withdraw({
        chain,
        tokenSymbol,
        toAddress: treasuryAddress,
        amount: feeAmount,
        reference: `${reference}-fee`,
      });
      await withTransaction((client) =>
        sendsRepo.logTransition(
          client,
          final.id,
          "PAYOUT_INITIATED",
          "PAYOUT_INITIATED",
          feeSweep.txHash ? `fee_swept:${feeSweep.txHash}` : "fee_swept_pending_screening",
        ),
      );
    } catch (err) {
      console.error(`Fee sweep failed for send ${final.id}:`, err);
      await withTransaction((client) =>
        sendsRepo.logTransition(
          client,
          final.id,
          "PAYOUT_INITIATED",
          "PAYOUT_INITIATED",
          `fee_sweep_failed: ${sanitizeForDb(err instanceof Error ? err.message : String(err))}`,
        ),
      );
    }
  }

  const fiatAmount = Number(netAmount) * Number(order.rate);
  const fiatEstimate = Number.isFinite(fiatAmount) ? fiatAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;
  const recipientLabel = input.recipient.institutionName ?? input.recipient.institution;
  const message = [
    `⏳ Your transaction with the following details is processing:`,
    `💸 Sent ${formatAmount(amount)} ${tokenSymbol} on ${capitalize(chain)} — ${input.recipient.accountName} at ${recipientLabel}` +
      (fiatEstimate ? ` will receive ${input.fiatCurrency} ${fiatEstimate}` : ""),
    ``,
    `This usually completes within a few minutes — we'll update you once it's confirmed.`,
  ].join("\n");

  return { send: final, receiveAddress: order.receiveAddress, validUntil: order.validUntil, message };
}
