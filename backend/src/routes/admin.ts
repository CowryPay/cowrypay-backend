import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { adminRepo } from "../domain/admin/repository.js";
import { requireAdminKey, requireMetricsKey } from "../middleware/requireAdminKey.js";
import { unmatchedStellarDepositsRepo } from "../domain/deposits/unmatchedStellarDepositsRepository.js";
import { walletsRepo } from "../domain/wallets/repository.js";
import { ingestDeposit } from "../domain/deposits/stateMachine.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { withTransaction } from "../db/pool.js";
import type { SendState } from "../types.js";
import { stellarWalletAdapter } from "../domain/wallets/stellarAdapter.js";
import { solanaWalletAdapter } from "../domain/wallets/solanaAdapter.js";
import { sendNativeToken } from "../domain/wallets/awsKmsAdapter.js";
import { getTreasurySnapshot } from "../domain/admin/treasury.js";
import { diagnoseStellarDeposits } from "../domain/admin/stellarDepositDiagnostic.js";
import { ledgerRepo } from "../domain/ledger/repository.js";
import { depositsRepo } from "../domain/deposits/repository.js";
import { reconcileSolanaWebhookAddresses } from "../domain/monitoring/solanaWebhookReconciler.js";
import { crossChainSendsRepo } from "../domain/crossChainSend/repository.js";

export const adminRouter = Router();

// Backs an internal ops dashboard (wallets created, chains/tokens in use,
// send/deposit activity) — same shape of need as Blockradar's own wallet
// overview page, but across every provider we actually use (aws-kms,
// Blockradar, Stellar, Solana), which no third-party dashboard can show.
adminRouter.get("/admin/overview", async (req: Request, res: Response) => {
  if (!requireMetricsKey(req, res)) return;
  const overview = await adminRepo.getOverview();
  res.json(overview);
});

// Investor/funding-facing numbers — narrower and more curated than
// /admin/overview's ops-health snapshot: settled volume and captured
// revenue only, never counting failed/pending attempts as if they were
// real activity.
adminRouter.get("/admin/metrics", async (req: Request, res: Response) => {
  if (!requireMetricsKey(req, res)) return;
  const metrics = await adminRepo.getMetrics();
  res.json(metrics);
});

// Day-by-day trend for growth charts (volume/revenue over time) — /admin/metrics
// only ever answers "what's the total right now," a single point that can't
// distinguish flat from growing. Clamped to [1, 365] so a bad/absent query
// param can't trigger an unbounded table scan.
adminRouter.get("/admin/metrics/timeseries", async (req: Request, res: Response) => {
  if (!requireMetricsKey(req, res)) return;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const timeseries = await adminRepo.getTimeseries(days);
  res.json({ days, timeseries });
});

// One-off export for ops use (product-update / feedback-request emails,
// etc.) — full admin key, not the metrics-scoped one, since PII (real
// user emails) is more sensitive than the aggregate numbers everything
// else on that key exposes.
adminRouter.get("/admin/users/emails", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const users = await adminRepo.listUserEmails();
  res.json({ count: users.length, users });
});

// Live on-chain balances, not anything derived from our own DB — two
// distinct groups: feeTreasury is what the platform has actually earned
// (the 3 dedicated fee-sweep addresses), operational is what pays out
// sends and needs to stay funded (real incident this session: the Solana
// treasury ran low on SOL and wallet creation started failing with zero
// visibility until a user hit the error — this is the early-warning view
// into that same problem, across every chain). Read-only, so it's on the
// same metrics-scoped key as the rest of the dashboard, not the full
// admin key.
adminRouter.get("/admin/treasury", async (req: Request, res: Response) => {
  if (!requireMetricsKey(req, res)) return;
  const snapshot = await getTreasurySnapshot();
  res.json(snapshot);
});

// Diagnostic: "why didn't the fee reach treasury" — shows each send's fee
// amount next to what the fee-sweep step actually logged, since a send
// reaching PAYOUT_INITIATED/COMPLETE says nothing about the fee sweep
// specifically (it's a best-effort step separate from the main payout).
adminRouter.get("/admin/sends", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const chain = typeof req.query.chain === "string" ? req.query.chain : undefined;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const sends = await adminRepo.listRecentSends(chain, limit);
  res.json({ sends });
});

// A memo-less/unrecognized Stellar deposit was never actually
// unrecoverable — stellarDepositScanner.ts already tracks it in
// unmatched_stellar_deposits, this just exposes that table instead of
// requiring a direct DB query every time a user reports a missing
// deposit.
adminRouter.get("/admin/stellar/unmatched-deposits", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const deposits = await unmatchedStellarDepositsRepo.listUnresolved();
  res.json({ deposits });
});

// Walks Horizon's own payment history directly (ground truth) and
// cross-checks each USDC payment against both the deposits table
// (credited) and unmatched_stellar_deposits (flagged) — surfaces anything
// in neither, which the unmatched-deposits list alone can't catch (e.g. a
// silent failure in ingestDeposit itself, or a scanner cursor stuck behind
// where it should be). See stellarDepositDiagnostic.ts for why this exists.
adminRouter.get("/admin/stellar/deposit-diagnostic", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const lookback = Math.min(Number(req.query.lookback) || 100, 500);
  const result = await diagnoseStellarDeposits(lookback);
  res.json(result);
});

const ResolveUnmatchedDepositSchema = z.object({
  userId: z.string().min(1),
  actor: z.string().min(1),
});

// Replays the deposit through the exact same ingestDeposit path a
// correctly-memo'd payment already goes through (see
// stellarDepositScanner.ts's matched branch) — not a separate, one-off
// ledger credit — so it goes through the normal DEPOSIT_DETECTED state
// machine and is safe/idempotent if ever called twice (ingestDeposit's
// own (chain, tx_hash) uniqueness).
adminRouter.post("/admin/stellar/unmatched-deposits/:id/resolve", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = ResolveUnmatchedDepositSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const deposit = await unmatchedStellarDepositsRepo.findById(req.params.id);
  if (!deposit) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (deposit.resolvedAt) {
    res.status(400).json({ error: "already resolved" });
    return;
  }

  const wallet = await walletsRepo.findByUserIdAndChain(parsed.data.userId, "stellar");
  if (!wallet) {
    res.status(400).json({ error: "that user has no Stellar wallet on record" });
    return;
  }

  await ingestDeposit({
    userId: parsed.data.userId,
    walletId: wallet.id,
    tokenSymbol: "USDC",
    amount: deposit.amount,
    chain: "stellar",
    txHash: deposit.txHash,
  });
  await unmatchedStellarDepositsRepo.markResolved(deposit.id, parsed.data.actor);

  res.json({ ok: true });
});

const CorrectSendStateSchema = z.object({
  state: z.enum([
    "SEND_INSTRUCTED",
    "COMPLIANCE_SCREENING",
    "MANUAL_REVIEW",
    "SEND_REJECTED",
    "ORDER_CREATED",
    "PAYOUT_INITIATED",
    "SETTLING",
    "COMPLETE",
    "FAILED",
    "REFUNDED",
  ]),
  note: z.string().min(1),
  actor: z.string().min(1),
  // Optional — for correcting a stale/wrong tx hash (real incident: a
  // payout broadcast that silently never reached the network left a
  // withdrawTxHash on the row for a transaction that doesn't exist,
  // requiring a re-broadcast and a correction to the real hash).
  withdrawTxHash: z.string().min(1).optional(),
});

// Real incident that motivated this: centiivSettlementPoller.ts treats
// metadata.rate becoming non-null as "settled," since no other terminal
// signal had ever been observed live — but a real order (Centiiv's own
// dashboard: status REFUNDED) proved that heuristic wrong, with a rate
// populated on an order that was never actually fulfilled. Our sends row
// showed COMPLETE while Centiiv's own system said REFUNDED, and on-chain
// tracing confirmed the crypto never returned to our registered refund
// address either.
//
// Read-only lookup by send ID, with full transition history — a direct
// complement to /admin/sends (chain-scoped listing) and the wallet-address-
// keyed ledger-audit, neither of which work well for tracing one specific
// send: Stellar wallet rows all share one on-chain address (no per-user
// address to look up by), so /admin/wallets/:address/... resolves to
// whichever user's row happens to match first, not necessarily the one
// who actually owns a given send.
adminRouter.get("/admin/sends/:id", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const send = await sendsRepo.findById(req.params.id);
  if (!send) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [transitions, userBalances] = await Promise.all([
    sendsRepo.getTransitions(send.id),
    ledgerRepo.getBalancesForUser(send.userId),
  ]);
  res.json({ send, transitions, userBalances });
});

// Same shape of gap as /admin/sends/:id above, for deposits: a Stellar
// deposit's own wallet address is the shared on-chain address, not a
// per-user one, so tracing a specific deposit report by its real tx hash
// needs a lookup keyed on (chain, txHash), not on wallet address.
adminRouter.get("/admin/deposits/by-hash", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const chain = typeof req.query.chain === "string" ? req.query.chain : undefined;
  const txHash = typeof req.query.txHash === "string" ? req.query.txHash : undefined;
  if (!chain || !txHash) {
    res.status(400).json({ error: "chain and txHash query params are required" });
    return;
  }
  const deposit = await depositsRepo.findByChainAndTxHash(chain, txHash);
  if (!deposit) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [transitions, userBalances, userDeposits] = await Promise.all([
    depositsRepo.getTransitions(deposit.id),
    ledgerRepo.getBalancesForUser(deposit.userId),
    depositsRepo.getForUser(deposit.userId, 20),
  ]);
  res.json({ deposit, transitions, userBalances, userDeposits });
});

// One-time audit for the double-credit race just fixed in
// stateMachine.ts's runScreening — finds every deposit (any chain) whose
// ledger credit ran more than once, so each can be reconciled by hand
// instead of assuming the one live-reported case was the only one.
adminRouter.get("/admin/deposits/audit-double-credits", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const affected = await adminRepo.findDoubleCreditedDeposits();
  res.json({ affected });
});

// Deliberately a pure audit correction, NOT applyTerminalFailureTransition
// (sendStateTransition.ts) — that helper always credits the send's user
// back, which is the right call when OUR system is the one that failed a
// send. This is the opposite case: the provider's own system disagrees
// with ours about what actually happened, and whether/how to make the
// user whole is a business decision, not something safe to automate.
adminRouter.post("/admin/sends/:id/correct-state", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = CorrectSendStateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const send = await sendsRepo.findById(req.params.id);
  if (!send) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const nextState = parsed.data.state as SendState;

  // Real incident this closes: reviving a send from FAILED/REFUNDED back
  // to a live state (exactly what happened when a payout's original
  // broadcast silently never landed, got auto-refunded by
  // withdrawConfirmationPoller.ts, and was then corrected here to its
  // real re-broadcast tx hash) left an earlier auto-refund uncorrected —
  // the send went on to genuinely complete a second time in effect,
  // leaving the user with a real phantom credit. Every single code path
  // in this codebase that sets FAILED or REFUNDED (applyTerminalFailureTransition,
  // both services' withdraw() catch blocks, withdrawConfirmationPoller.ts's
  // reverted-detection) does so atomically together with a ledger credit
  // for send.amountHuman — no exception exists anywhere. So "current
  // state is FAILED/REFUNDED" reliably means "the user was already
  // credited," and reviving it to any non-terminal state must reverse
  // that credit in the same transaction, not leave it to be forgotten a
  // second time. Refuses to proceed at all if the reversal can't apply
  // (insufficient balance) rather than silently applying just the state
  // change and reproducing the exact bug this exists to prevent.
  const revivingFromCreditedFailure =
    (send.state === "FAILED" || send.state === "REFUNDED") && nextState !== "FAILED" && nextState !== "REFUNDED";

  try {
    await withTransaction(async (client) => {
      if (revivingFromCreditedFailure) {
        const debited = await ledgerRepo.debitAvailable(client, send.userId, send.tokenSymbol, send.chain, send.amountHuman);
        if (!debited) {
          throw new Error(
            `Cannot revive send ${send.id}: reversing its earlier auto-refund (${send.amountHuman} ${send.tokenSymbol}) would require debiting more than the user's current available balance. Resolve the balance conflict before correcting this send's state.`,
          );
        }
      }
      await sendsRepo.updateState(client, send.id, { state: nextState, withdrawTxHash: parsed.data.withdrawTxHash });
      await sendsRepo.logTransition(
        client,
        send.id,
        send.state,
        nextState,
        revivingFromCreditedFailure
          ? `admin_correction (reversed earlier auto-refund of ${send.amountHuman} ${send.tokenSymbol}): ${parsed.data.note}`
          : `admin_correction: ${parsed.data.note}`,
        parsed.data.actor,
      );
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const StellarTreasuryTransferSchema = z.object({
  toAddress: z.string().min(1),
  amount: z.string().min(1),
  reference: z.string().min(1),
});

// One-off ops tool for moving funds between our own Stellar-controlled
// wallets (e.g. sweeping a recovered provider refund from the Centiiv-
// registered refund address into the platform fee treasury) — reuses
// stellarWalletAdapter.withdraw() rather than a standalone script so the
// transaction goes through the SAME in-process serialize() queue as every
// other live withdraw off this shared omnibus account. A script running
// outside the server process would read the account's sequence number
// independently of that queue and could race real production withdraws
// happening at the same time (tx_bad_seq for one side or the other) — the
// exact failure mode serialize() exists to prevent.
adminRouter.post("/admin/stellar/treasury-transfer", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = StellarTreasuryTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  try {
    const result = await stellarWalletAdapter.withdraw({
      chain: "stellar",
      tokenSymbol: "USDC",
      toAddress: parsed.data.toAddress,
      amount: parsed.data.amount,
      reference: parsed.data.reference,
    });
    res.json({ ok: true, txHash: result.txHash, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const SolanaTreasuryTransferSchema = z.object({
  toAddress: z.string().min(1),
  amount: z.string().min(1),
  reference: z.string().min(1),
  tokenSymbol: z.string().min(1).default("USDC"),
});

// Solana equivalent of /admin/stellar/treasury-transfer above — same
// one-off ops need (e.g. sweeping a send's fee_amount to the fee treasury
// after the confirmation-wait bug fixed in 99db41f left it unswept, since
// that crash happened before the normal fee-sweep step in
// offramp/service.ts ever ran). Goes through solanaWalletAdapter.withdraw
// rather than a standalone script for the same reason as the Stellar
// version: the treasury signer's real balance/ATA state should only ever
// be touched via the app's own adapter, not a script racing it outside
// the process.
adminRouter.post("/admin/solana/treasury-transfer", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = SolanaTreasuryTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  try {
    const result = await solanaWalletAdapter.withdraw({
      chain: "solana",
      tokenSymbol: parsed.data.tokenSymbol,
      toAddress: parsed.data.toAddress,
      amount: parsed.data.amount,
      reference: parsed.data.reference,
    });
    res.json({ ok: true, txHash: result.txHash, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const EvmNativeTransferSchema = z.object({
  chain: z.string().min(1),
  toAddress: z.string().min(1),
  amount: z.string().min(1),
  note: z.string().min(1),
  actor: z.string().min(1),
});

// EVM equivalent of /admin/stellar/treasury-transfer above, for the
// payout wallet's own native gas token (CELO/ETH) rather than USDC/USDT —
// e.g. topping up gas on another wallet the operator controls. Goes
// through sendNativeToken (awsKmsAdapter.ts), which uses the exact same
// nonce-claiming path and cross-process advisory lock as every real
// payout from this wallet, for the same race-safety reason the Stellar
// version's own comment explains.
adminRouter.post("/admin/evm/native-transfer", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = EvmNativeTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const { chain, toAddress, amount, note, actor } = parsed.data;
  console.log(`[admin] EVM native transfer: ${amount} native token on ${chain} to ${toAddress} — actor=${actor}, note="${note}"`);
  try {
    const txHash = await sendNativeToken(chain, toAddress as `0x${string}`, amount);
    res.json({ ok: true, txHash });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Traces a "my balance looks wrong" report back to its actual source —
// resolves a wallet address to its user, then returns that user's real
// ledger balances (what the app shows) alongside their send history (what
// actually happened), so a discrepancy can be pinned to a specific send
// instead of guessed at from the ledger numbers alone.
adminRouter.get("/admin/wallets/:address/diagnostic", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const wallet = await walletsRepo.findByAddress(req.params.address);
  if (!wallet) {
    res.status(404).json({ error: "no wallet found for this address" });
    return;
  }
  const [balances, sends, deposits] = await Promise.all([
    ledgerRepo.getBalancesForUser(wallet.userId),
    adminRepo.listSendsForUser(wallet.userId, 50),
    depositsRepo.listForUser(wallet.userId, 50),
  ]);
  res.json({ userId: wallet.userId, walletAddress: wallet.address, balances, sends, deposits });
});

// Real incident that motivated this: the summary-level diagnostic above
// showed deposits and sends that, added up, should net to a 0 balance on
// Base for one user — but their actual ledger balance was 9.8. Neither
// number alone explains it; the exact sequence of ledger-affecting events
// (which credit/debit happened, in what order, from which trigger) is
// needed to find where the arithmetic actually breaks — same precision
// used to nail the Celo double-credit down to an exact tx-hash match,
// applied here as a general-purpose tool instead of one-off scripting.
// Merges every send's and deposit's own transition log into one
// chronological timeline, since a discrepancy like this lives in the
// ORDER events happened, not just their totals.
adminRouter.get("/admin/wallets/:address/ledger-audit", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const wallet = await walletsRepo.findByAddress(req.params.address);
  if (!wallet) {
    res.status(404).json({ error: "no wallet found for this address" });
    return;
  }
  const chain = typeof req.query.chain === "string" ? req.query.chain : undefined;

  const [sends, deposits] = await Promise.all([
    adminRepo.listSendsForUser(wallet.userId, 100),
    depositsRepo.listForUser(wallet.userId, 100),
  ]);
  const relevantSends = chain ? sends.filter((s) => s.chain === chain) : sends;
  const relevantDeposits = chain ? deposits.filter((d) => d.chain === chain) : deposits;

  const sendTimelines = await Promise.all(
    relevantSends.map(async (s) => ({
      kind: "send" as const,
      id: s.id,
      chain: s.chain,
      amount: s.amountHuman,
      transitions: await sendsRepo.getTransitions(s.id),
    })),
  );
  const depositTimelines = await Promise.all(
    relevantDeposits.map(async (d) => ({
      kind: "deposit" as const,
      id: d.id,
      chain: d.chain,
      amount: d.amount,
      transitions: await depositsRepo.getTransitions(d.id),
    })),
  );

  const events = [...sendTimelines, ...depositTimelines]
    .flatMap((entry) =>
      entry.transitions.map((t) => ({
        kind: entry.kind,
        id: entry.id,
        chain: entry.chain,
        amount: entry.amount,
        fromState: t.fromState,
        toState: t.toState,
        trigger: t.trigger,
        actor: t.actor,
        createdAt: t.createdAt,
      })),
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  res.json({ userId: wallet.userId, walletAddress: wallet.address, events });
});

const AdjustLedgerSchema = z.object({
  chain: z.string().min(1),
  tokenSymbol: z.string().min(1),
  amount: z.string().min(1),
  direction: z.enum(["credit", "debit"]),
  note: z.string().min(1),
  actor: z.string().min(1),
});

// Real incident that motivated this: a provider refund landing directly
// in a user's own AWS-KMS wallet is indistinguishable from an ordinary
// deposit to the deposit scanner, so the same on-chain transfer got
// credited twice — once via the send's own REFUNDED transition, once via
// the scanner picking it up as new money (confirmed by an exact tx-hash
// match between the "deposit" and the provider's own refund transaction).
// No dedicated ledger-adjustment table exists — logged to console (same
// as every other admin correction this session) with a required note/
// actor, not silently applied.
adminRouter.post("/admin/wallets/:address/adjust-ledger", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = AdjustLedgerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const wallet = await walletsRepo.findByAddress(req.params.address);
  if (!wallet) {
    res.status(404).json({ error: "no wallet found for this address" });
    return;
  }

  const { chain, tokenSymbol, amount, direction, note, actor } = parsed.data;
  console.log(
    `[admin] ledger adjustment: user ${wallet.userId} ${direction} ${amount} ${tokenSymbol} on ${chain} — actor=${actor}, note="${note}"`,
  );

  try {
    const balance = await withTransaction(async (client) => {
      if (direction === "credit") {
        return ledgerRepo.creditAvailable(client, wallet.userId, tokenSymbol, chain, amount);
      }
      const result = await ledgerRepo.debitAvailable(client, wallet.userId, tokenSymbol, chain, amount);
      if (!result) throw new Error("insufficient available balance for this debit");
      return result;
    });
    res.json({ ok: true, balance });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Same operation as the address-keyed endpoint above, keyed by userId
// directly instead — required for Stellar (and any other shared-address
// chain), where findByAddress has no way to tell which of many users
// sharing that one on-chain address a correction is actually meant for,
// and would silently resolve to an arbitrary one. Use this whenever the
// target user is already known (e.g. from /admin/deposits/by-hash), not
// the address-keyed version, for any chain where the wallet address isn't
// genuinely unique per user.
adminRouter.post("/admin/users/:userId/adjust-ledger", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = AdjustLedgerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const { chain, tokenSymbol, amount, direction, note, actor } = parsed.data;
  const userId = req.params.userId;
  console.log(
    `[admin] ledger adjustment: user ${userId} ${direction} ${amount} ${tokenSymbol} on ${chain} — actor=${actor}, note="${note}"`,
  );

  try {
    const balance = await withTransaction(async (client) => {
      if (direction === "credit") {
        return ledgerRepo.creditAvailable(client, userId, tokenSymbol, chain, amount);
      }
      const result = await ledgerRepo.debitAvailable(client, userId, tokenSymbol, chain, amount);
      if (!result) throw new Error("insufficient available balance for this debit");
      return result;
    });
    res.json({ ok: true, balance });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Manual trigger for the periodic reconciler (see solanaWebhookReconciler.ts)
// — lets a fix land immediately instead of waiting up to 10 minutes for the
// next scheduled cycle, e.g. right after a deploy meant to backfill
// addresses missed by the per-wallet-creation registration's own race.
adminRouter.post("/admin/solana/reconcile-webhook", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  try {
    await reconcileSolanaWebhookAddresses();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ManualIngestDepositSchema = z.object({
  userId: z.string().min(1),
  chain: z.string().min(1),
  tokenSymbol: z.string().min(1),
  amount: z.string().min(1),
  txHash: z.string().min(1),
  actor: z.string().min(1),
});

// General-purpose version of /admin/stellar/unmatched-deposits/:id/resolve
// above, for any chain — a real deposit that automated detection missed
// entirely (e.g. the Solana webhook registration bug just fixed) needs the
// same replay-through-ingestDeposit path, not a one-off ledger credit.
// Safe/idempotent if ever called twice, same reasoning as that endpoint:
// ingestDeposit's own (chain, tx_hash) uniqueness makes a repeat call a
// no-op rather than a double-credit.
adminRouter.post("/admin/deposits/ingest", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = ManualIngestDepositSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const { userId, chain, tokenSymbol, amount, txHash, actor } = parsed.data;
  const wallet = await walletsRepo.findByUserIdAndChain(userId, chain);
  if (!wallet) {
    res.status(400).json({ error: `that user has no ${chain} wallet on record` });
    return;
  }

  console.log(`[admin] manual deposit ingest: user ${userId} ${amount} ${tokenSymbol} on ${chain} tx=${txHash} — actor=${actor}`);
  try {
    const result = await ingestDeposit({ userId, walletId: wallet.id, tokenSymbol, amount, chain, txHash });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ManualCrossChainRefundSchema = z.object({
  note: z.string().min(1),
  actor: z.string().min(1),
});

// The deliberate, audited exception to "a confirmed source-chain burn is
// never auto-refunded" (see crossChainSendConfirmationPoller.ts's own
// comment) — only for a STUCK send an admin has independently determined
// is genuinely unrecoverable (e.g. the bridge vendor's contract is
// permanently paused), never a routine retry path. `actor` is required
// and gets logged as-is in cross_chain_send_state_transitions (not
// "system"), so this is always traceable to a specific human decision.
adminRouter.post("/admin/cross-chain-sends/:id/manual-refund", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = ManualCrossChainRefundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }

  const send = await crossChainSendsRepo.findById(req.params.id);
  if (!send) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (send.state !== "STUCK") {
    res.status(400).json({ error: `send is ${send.state}, not STUCK — manual refund only applies to a stuck send` });
    return;
  }

  try {
    await withTransaction(async (client) => {
      const updated = await crossChainSendsRepo.updateStateIfCurrent(client, send.id, "STUCK", { state: "REFUNDED" });
      if (!updated) throw new Error("send is no longer STUCK — it may have completed or been resolved already");
      await ledgerRepo.creditAvailable(client, send.userId, send.tokenSymbol, send.sourceChain, send.amountHuman);
      await crossChainSendsRepo.logTransition(
        client,
        send.id,
        "STUCK",
        "REFUNDED",
        `manual_refund: ${parsed.data.note}`,
        parsed.data.actor,
      );
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
