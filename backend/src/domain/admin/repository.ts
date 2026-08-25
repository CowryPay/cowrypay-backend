import { pool } from "../../db/pool.js";
import { formatAmount } from "../../utils/format.js";
import { getTreasurySnapshot, type ReconciliationRow } from "./treasury.js";

// node-pg parses a `date` column into a JS Date at UTC midnight — this
// normalizes it back to the same "YYYY-MM-DD" string used as the map key
// below, so a Postgres-returned day and a JS-constructed day always match.
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface AdminOverview {
  users: {
    total: number;
    kycVerified: number;
  };
  wallets: {
    total: number;
    byChain: { chain: string; count: number }[];
    byProvider: { provider: string; count: number }[];
  };
  balances: {
    // Ledger balances (what users actually hold), not on-chain treasury
    // balances — those live on-chain per adapter and aren't something a
    // single SQL query can answer across Blockradar + aws-kms + Stellar +
    // Solana at once.
    byChainAndToken: { chain: string; tokenSymbol: string; totalAvailable: string; totalPending: string }[];
  };
  sends: {
    total: number;
    byState: { state: string; count: number }[];
    byChain: { chain: string; count: number }[];
  };
  deposits: {
    total: number;
    byState: { state: string; count: number }[];
  };
  recipients: {
    total: number;
  };
}

export interface AdminMetrics {
  wallets: {
    totalCreated: number;
  };
  users: {
    total: number;
    // "Active" = actually moved settled money at least once — a signup
    // with a wallet but no completed send/deposit isn't active by any
    // investor-facing definition. last30Days uses each transaction's own
    // created_at as a proxy for "when this user was active" (not a
    // separate last-login concept, which doesn't exist in this codebase).
    activeAllTime: number;
    activeToday: number; // DAU
    activeLast7Days: number; // WAU
    activeLast30Days: number;
  };
  transactions: {
    // "total" = every attempt ever created, including ones that failed or
    // never settled — shown alongside "settled" rather than instead of it,
    // so this can't be quoted as if every attempt were real, moved money.
    sends: { total: number; settled: number };
    deposits: { total: number; settled: number };
    // cryptoWithdrawals/crossChainSends were missing entirely until this
    // was added (2026-08-21) — two of the four ways money actually leaves
    // the platform had zero admin volume visibility. crossChainSends'
    // "settled" is its own COMPLETE state, not sends'/deposits' terminal
    // states — see cross_chain_sends' own check constraint.
    cryptoWithdrawals: { total: number; settled: number };
    crossChainSends: { total: number; settled: number };
    // crossChainSends is keyed by SOURCE chain here (the chain actually
    // debited) — a cross-chain send has two chains, and "which chain did
    // this transaction's volume come FROM" is the same question byChain
    // already answers for sends/deposits/withdrawals.
    byChain: { chain: string; sends: number; deposits: number; cryptoWithdrawals: number; crossChainSends: number }[];
  };
  // Only settled amounts (sends: COMPLETE, deposits: BALANCE_CREDITED,
  // cryptoWithdrawals: CONFIRMED, crossChainSends: COMPLETE) — volume from
  // failed/pending attempts isn't real on-chain volume. Plain numeric
  // strings, no currency symbol — see the field names for what they are;
  // formatting for display (a "$", comma grouping, etc.) is the
  // frontend's job, not this API's.
  onChainVolume: {
    sentUsdc: string;
    depositedUsdc: string;
    withdrawnUsdc: string;
    crossChainSentUsdc: string;
    byChain: {
      chain: string;
      sentUsdc: string;
      depositedUsdc: string;
      withdrawnUsdc: string;
      crossChainSentUsdc: string;
    }[];
  };
  // Platform fee actually captured on settled transactions only — a fee
  // swept from a send that later gets refunded/fails isn't real revenue
  // (see offramp/service.ts's fee-sweep step, which runs on broadcast,
  // before Paycrest's final settlement confirms). Same reasoning now
  // applied to cryptoWithdrawals/crossChainSends fee revenue, which was
  // previously invisible here even though both flows charge a real fee
  // (see offramp/fee.ts's computeCryptoWithdrawalFeeSplit/
  // computeCrossChainSendFeeSplit).
  revenue: {
    totalFeesUsdc: string;
    byChain: { chain: string; feesUsdc: string }[];
  };
  // The actual "prove you're solvent" answer for a funding conversation —
  // reuses treasury.ts's own live on-chain reconciliation (GET
  // /admin/treasury) rather than recomputing it, so there's one source of
  // truth for what "fully reserved" means. fullyReserved is conservative
  // on purpose: an UNKNOWN row (an on-chain read that failed, not
  // necessarily a real shortfall) still blocks a clean "yes" — better to
  // under-claim than assert solvency off a chain we couldn't actually
  // verify just now.
  reserves: {
    fullyReserved: boolean;
    breakdown: ReconciliationRow[];
  };
}

export interface AdminMetricsDay {
  date: string; // YYYY-MM-DD
  sendsCount: number;
  depositsCount: number;
  cryptoWithdrawalsCount: number;
  crossChainSendsCount: number;
  sentUsdc: string;
  depositedUsdc: string;
  withdrawnUsdc: string;
  crossChainSentUsdc: string;
  // Combined across all three fee-charging flows (sends, cryptoWithdrawals,
  // crossChainSends) — same "one revenue number per period" framing
  // getMetrics()'s totalFeesUsdc uses, not a per-flow breakdown.
  feesUsdc: string;
}

export interface AdminSendDiagnostic {
  id: string;
  chain: string;
  amountHuman: string;
  feeAmount: string | null;
  treasuryAddress: string | null;
  state: string;
  withdrawTxHash: string | null;
  createdAt: string;
  provider: string;
  // How long between creation and actually reaching COMPLETE — the real
  // question behind "user says it settled in their bank but the app still
  // shows processing": is our system just slow to find out (webhook/
  // poller lag), or genuinely stuck? Null if not yet COMPLETE.
  completedAt: string | null;
  settlementTrigger: string | null;
  // The most recent transition whose trigger mentions the fee sweep
  // (offramp/service.ts logs "fee_swept:<hash>" or
  // "fee_sweep_failed: <error>") — null means the fee-sweep step was never
  // reached at all (e.g. the payout itself failed before getting there).
  feeSweepTrigger: string | null;
  // Needed to look a stuck send up directly against the provider's own API
  // (e.g. Paycrest's GET /sender/orders/:id) — without it, diagnosing a
  // "stuck" send means guessing which of the provider's own orders it
  // corresponds to.
  providerOrderId: string | null;
}

// One-shot cross-user aggregate read for the admin overview dashboard —
// deliberately separate from every other repository here, which are all
// scoped to a single user's own data by design (every route in this
// backend answers "what does this authenticated user see", never "give me
// everyone's data"). Kept as plain aggregate SQL rather than assembled from
// the per-user repos above, since none of those expose an unscoped,
// all-users query and shouldn't start to.
export const adminRepo = {
  async getOverview(): Promise<AdminOverview> {
    const [
      usersTotal,
      usersKyc,
      walletsTotal,
      walletsByChain,
      walletsByProvider,
      balancesByChainAndToken,
      sendsTotal,
      sendsByState,
      sendsByChain,
      depositsTotal,
      depositsByState,
      recipientsTotal,
    ] = await Promise.all([
      pool.query(`select count(*)::int as count from users`),
      pool.query(`select count(*)::int as count from users where kyc_status = 'VERIFIED'`),
      pool.query(`select count(*)::int as count from wallets`),
      pool.query(`select chain, count(*)::int as count from wallets group by chain order by chain`),
      pool.query(`select provider, count(*)::int as count from wallets group by provider order by provider`),
      pool.query(
        `select chain, token_symbol, coalesce(sum(available_balance), 0) as total_available, coalesce(sum(pending_balance), 0) as total_pending
         from ledger_balances group by chain, token_symbol order by chain, token_symbol`,
      ),
      pool.query(`select count(*)::int as count from sends`),
      pool.query(`select state, count(*)::int as count from sends group by state order by state`),
      pool.query(`select chain, count(*)::int as count from sends group by chain order by chain`),
      pool.query(`select count(*)::int as count from deposits`),
      pool.query(`select state, count(*)::int as count from deposits group by state order by state`),
      pool.query(`select count(*)::int as count from recipients`),
    ]);

    return {
      users: {
        total: usersTotal.rows[0].count,
        kycVerified: usersKyc.rows[0].count,
      },
      wallets: {
        total: walletsTotal.rows[0].count,
        byChain: walletsByChain.rows.map((r) => ({ chain: r.chain, count: r.count })),
        byProvider: walletsByProvider.rows.map((r) => ({ provider: r.provider, count: r.count })),
      },
      balances: {
        byChainAndToken: balancesByChainAndToken.rows.map((r) => ({
          chain: r.chain,
          tokenSymbol: r.token_symbol,
          totalAvailable: r.total_available,
          totalPending: r.total_pending,
        })),
      },
      sends: {
        total: sendsTotal.rows[0].count,
        byState: sendsByState.rows.map((r) => ({ state: r.state, count: r.count })),
        byChain: sendsByChain.rows.map((r) => ({ chain: r.chain, count: r.count })),
      },
      deposits: {
        total: depositsTotal.rows[0].count,
        byState: depositsByState.rows.map((r) => ({ state: r.state, count: r.count })),
      },
      recipients: {
        total: recipientsTotal.rows[0].count,
      },
    };
  },

  async getMetrics(): Promise<AdminMetrics> {
    const [
      walletsTotal,
      usersTotal,
      activeAllTime,
      activeToday,
      activeLast7Days,
      activeLast30Days,
      sendsTotal,
      sendsSettled,
      depositsTotal,
      depositsSettled,
      withdrawalsTotal,
      withdrawalsSettled,
      crossChainTotal,
      crossChainSettled,
      sendsByChain,
      depositsByChain,
      withdrawalsByChain,
      crossChainByChain,
      volumeSentByChain,
      volumeDepositedByChain,
      volumeWithdrawnByChain,
      volumeCrossChainByChain,
      feesBySendChain,
      feesByWithdrawalChain,
      feesByCrossChainChain,
      totalSent,
      totalDeposited,
      totalWithdrawn,
      totalCrossChainSent,
      totalSendFees,
      totalWithdrawalFees,
      totalCrossChainFees,
      treasurySnapshot,
    ] = await Promise.all([
      pool.query(`select count(*)::int as count from wallets`),
      pool.query(`select count(*)::int as count from users`),
      pool.query(
        `select count(distinct user_id)::int as count from (
           select user_id from sends where state = 'COMPLETE'
           union
           select user_id from deposits where state = 'BALANCE_CREDITED'
         ) active_users`,
      ),
      pool.query(
        `select count(distinct user_id)::int as count from (
           select user_id from sends where state = 'COMPLETE' and created_at >= now() - interval '1 day'
           union
           select user_id from deposits where state = 'BALANCE_CREDITED' and created_at >= now() - interval '1 day'
         ) active_users`,
      ),
      pool.query(
        `select count(distinct user_id)::int as count from (
           select user_id from sends where state = 'COMPLETE' and created_at >= now() - interval '7 days'
           union
           select user_id from deposits where state = 'BALANCE_CREDITED' and created_at >= now() - interval '7 days'
         ) active_users`,
      ),
      pool.query(
        `select count(distinct user_id)::int as count from (
           select user_id from sends where state = 'COMPLETE' and created_at >= now() - interval '30 days'
           union
           select user_id from deposits where state = 'BALANCE_CREDITED' and created_at >= now() - interval '30 days'
         ) active_users`,
      ),
      pool.query(`select count(*)::int as count from sends`),
      pool.query(`select count(*)::int as count from sends where state = 'COMPLETE'`),
      pool.query(`select count(*)::int as count from deposits`),
      pool.query(`select count(*)::int as count from deposits where state = 'BALANCE_CREDITED'`),
      pool.query(`select count(*)::int as count from crypto_withdrawals`),
      pool.query(`select count(*)::int as count from crypto_withdrawals where state = 'CONFIRMED'`),
      pool.query(`select count(*)::int as count from cross_chain_sends`),
      pool.query(`select count(*)::int as count from cross_chain_sends where state = 'COMPLETE'`),
      pool.query(`select chain, count(*)::int as count from sends group by chain order by chain`),
      pool.query(`select chain, count(*)::int as count from deposits group by chain order by chain`),
      pool.query(`select chain, count(*)::int as count from crypto_withdrawals group by chain order by chain`),
      // Grouped by SOURCE chain — see AdminMetrics's own doc comment on why
      // a cross-chain send's "chain" for volume/count purposes is the one
      // it actually debited from, not the destination.
      pool.query(
        `select source_chain as chain, count(*)::int as count from cross_chain_sends group by source_chain order by source_chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(amount_human), 0) as total from sends where state = 'COMPLETE' group by chain order by chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(amount), 0) as total from deposits where state = 'BALANCE_CREDITED' group by chain order by chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(amount_human), 0) as total from crypto_withdrawals where state = 'CONFIRMED' group by chain order by chain`,
      ),
      pool.query(
        `select source_chain as chain, coalesce(sum(amount_human), 0) as total from cross_chain_sends where state = 'COMPLETE' group by source_chain order by source_chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(fee_amount), 0) as total from sends where state = 'COMPLETE' group by chain order by chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(fee_amount), 0) as total from crypto_withdrawals where state = 'CONFIRMED' group by chain order by chain`,
      ),
      pool.query(
        `select source_chain as chain, coalesce(sum(fee_amount), 0) as total from cross_chain_sends where state = 'COMPLETE' group by source_chain order by source_chain`,
      ),
      // Summed once more directly in SQL rather than adding up the
      // per-chain numeric strings above in JS — a Number() round-trip on
      // money is exactly what formatAmount's own doc comment (and every
      // ledger write in this codebase) deliberately avoids.
      pool.query(`select coalesce(sum(amount_human), 0) as total from sends where state = 'COMPLETE'`),
      pool.query(`select coalesce(sum(amount), 0) as total from deposits where state = 'BALANCE_CREDITED'`),
      pool.query(`select coalesce(sum(amount_human), 0) as total from crypto_withdrawals where state = 'CONFIRMED'`),
      pool.query(`select coalesce(sum(amount_human), 0) as total from cross_chain_sends where state = 'COMPLETE'`),
      pool.query(`select coalesce(sum(fee_amount), 0) as total from sends where state = 'COMPLETE'`),
      pool.query(`select coalesce(sum(fee_amount), 0) as total from crypto_withdrawals where state = 'CONFIRMED'`),
      pool.query(`select coalesce(sum(fee_amount), 0) as total from cross_chain_sends where state = 'COMPLETE'`),
      // Only piece of getMetrics() that isn't a plain DB aggregate — this
      // one does live on-chain reads across every chain (same call
      // GET /admin/treasury makes). Run alongside everything else in this
      // Promise.all rather than after it, so it doesn't add its own
      // sequential RTT on top of the DB queries.
      getTreasurySnapshot(),
    ]);

    // Per-chain counts/volume/fees are each separate group-by queries
    // (different tables, different filters, cross-chain-sends grouped by
    // source_chain) — merged here into one row per chain rather than
    // forcing a single SQL query to outer-join five independently-shaped
    // aggregates.
    const chains = new Set<string>([
      ...sendsByChain.rows.map((r) => r.chain),
      ...depositsByChain.rows.map((r) => r.chain),
      ...withdrawalsByChain.rows.map((r) => r.chain),
      ...crossChainByChain.rows.map((r) => r.chain),
    ]);
    const sendsByChainMap = new Map(sendsByChain.rows.map((r) => [r.chain, r.count]));
    const depositsByChainMap = new Map(depositsByChain.rows.map((r) => [r.chain, r.count]));
    const withdrawalsByChainMap = new Map(withdrawalsByChain.rows.map((r) => [r.chain, r.count]));
    const crossChainByChainMap = new Map(crossChainByChain.rows.map((r) => [r.chain, r.count]));
    const sentVolumeByChainMap = new Map(volumeSentByChain.rows.map((r) => [r.chain, r.total]));
    const depositedVolumeByChainMap = new Map(volumeDepositedByChain.rows.map((r) => [r.chain, r.total]));
    const withdrawnVolumeByChainMap = new Map(volumeWithdrawnByChain.rows.map((r) => [r.chain, r.total]));
    const crossChainVolumeByChainMap = new Map(volumeCrossChainByChain.rows.map((r) => [r.chain, r.total]));

    // Fee revenue is the SAME platform-revenue number regardless of which
    // flow generated it — merged into one per-chain total (not a per-flow
    // breakdown) to match revenue.byChain's existing "revenue by chain"
    // framing, now actually including all three fee-charging flows
    // instead of just sends.
    const revenueByChainMap = new Map<string, number>();
    for (const rows of [feesBySendChain.rows, feesByWithdrawalChain.rows, feesByCrossChainChain.rows]) {
      for (const r of rows) {
        revenueByChainMap.set(r.chain, (revenueByChainMap.get(r.chain) ?? 0) + Number(r.total));
      }
    }

    const byChain = [...chains].sort().map((chain) => ({
      chain,
      sends: sendsByChainMap.get(chain) ?? 0,
      deposits: depositsByChainMap.get(chain) ?? 0,
      cryptoWithdrawals: withdrawalsByChainMap.get(chain) ?? 0,
      crossChainSends: crossChainByChainMap.get(chain) ?? 0,
    }));

    const volumeByChain = [...chains].sort().map((chain) => ({
      chain,
      sentUsdc: formatAmount(String(sentVolumeByChainMap.get(chain) ?? "0")),
      depositedUsdc: formatAmount(String(depositedVolumeByChainMap.get(chain) ?? "0")),
      withdrawnUsdc: formatAmount(String(withdrawnVolumeByChainMap.get(chain) ?? "0")),
      crossChainSentUsdc: formatAmount(String(crossChainVolumeByChainMap.get(chain) ?? "0")),
    }));

    // Unlike sends/deposits volume above (each a single SQL sum(), no JS
    // arithmetic involved), combined fee revenue genuinely does add three
    // already-aggregated totals in JS here — there's no ledger write or
    // stored balance riding on this number, only an admin dashboard
    // display value, so summing three small, already-rounded currency
    // totals with Number() carries none of the precision risk
    // formatAmount's own doc comment warns about for real money movement.
    const revenueChainBreakdown = [...revenueByChainMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([chain, total]) => ({ chain, feesUsdc: formatAmount(String(total)) }));
    const totalFeesUsdc =
      Number(totalSendFees.rows[0].total) + Number(totalWithdrawalFees.rows[0].total) + Number(totalCrossChainFees.rows[0].total);

    return {
      wallets: { totalCreated: walletsTotal.rows[0].count },
      users: {
        total: usersTotal.rows[0].count,
        activeAllTime: activeAllTime.rows[0].count,
        activeToday: activeToday.rows[0].count,
        activeLast7Days: activeLast7Days.rows[0].count,
        activeLast30Days: activeLast30Days.rows[0].count,
      },
      transactions: {
        sends: { total: sendsTotal.rows[0].count, settled: sendsSettled.rows[0].count },
        deposits: { total: depositsTotal.rows[0].count, settled: depositsSettled.rows[0].count },
        cryptoWithdrawals: { total: withdrawalsTotal.rows[0].count, settled: withdrawalsSettled.rows[0].count },
        crossChainSends: { total: crossChainTotal.rows[0].count, settled: crossChainSettled.rows[0].count },
        byChain,
      },
      onChainVolume: {
        sentUsdc: formatAmount(String(totalSent.rows[0].total)),
        depositedUsdc: formatAmount(String(totalDeposited.rows[0].total)),
        withdrawnUsdc: formatAmount(String(totalWithdrawn.rows[0].total)),
        crossChainSentUsdc: formatAmount(String(totalCrossChainSent.rows[0].total)),
        byChain: volumeByChain,
      },
      revenue: {
        totalFeesUsdc: formatAmount(String(totalFeesUsdc)),
        byChain: revenueChainBreakdown,
      },
      reserves: {
        fullyReserved: treasurySnapshot.reconciliation.every((r) => r.status === "OK"),
        breakdown: treasurySnapshot.reconciliation,
      },
    };
  },

  // Day-by-day trend for growth charts — getMetrics() above only answers
  // "what's the total right now," which can't distinguish flat from
  // growing. Bucketed by each row's own created_at (not a separate
  // completion timestamp) — same simplification getMetrics() already
  // makes, and accurate enough given off-ramp settlement here typically
  // finishes within minutes of creation, not days later. Every day in the
  // range is present in the output, zero-filled, even with no activity —
  // charting libraries want a continuous series, not sparse points.
  async getTimeseries(days: number): Promise<AdminMetricsDay[]> {
    const [sendsByDay, depositsByDay, withdrawalsByDay, crossChainByDay] = await Promise.all([
      pool.query(
        `select date_trunc('day', created_at)::date as day,
                count(*)::int as count,
                coalesce(sum(amount_human), 0) as sent_usdc,
                coalesce(sum(fee_amount), 0) as fees_usdc
         from sends
         where state = 'COMPLETE' and created_at >= now() - ($1 || ' days')::interval
         group by day`,
        [days],
      ),
      pool.query(
        `select date_trunc('day', created_at)::date as day,
                count(*)::int as count,
                coalesce(sum(amount), 0) as deposited_usdc
         from deposits
         where state = 'BALANCE_CREDITED' and created_at >= now() - ($1 || ' days')::interval
         group by day`,
        [days],
      ),
      pool.query(
        `select date_trunc('day', created_at)::date as day,
                count(*)::int as count,
                coalesce(sum(amount_human), 0) as withdrawn_usdc,
                coalesce(sum(fee_amount), 0) as fees_usdc
         from crypto_withdrawals
         where state = 'CONFIRMED' and created_at >= now() - ($1 || ' days')::interval
         group by day`,
        [days],
      ),
      pool.query(
        `select date_trunc('day', created_at)::date as day,
                count(*)::int as count,
                coalesce(sum(amount_human), 0) as sent_usdc,
                coalesce(sum(fee_amount), 0) as fees_usdc
         from cross_chain_sends
         where state = 'COMPLETE' and created_at >= now() - ($1 || ' days')::interval
         group by day`,
        [days],
      ),
    ]);

    const sendsByDayMap = new Map(sendsByDay.rows.map((r) => [dayKey(r.day), r]));
    const depositsByDayMap = new Map(depositsByDay.rows.map((r) => [dayKey(r.day), r]));
    const withdrawalsByDayMap = new Map(withdrawalsByDay.rows.map((r) => [dayKey(r.day), r]));
    const crossChainByDayMap = new Map(crossChainByDay.rows.map((r) => [dayKey(r.day), r]));

    const result: AdminMetricsDay[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);

      const sendRow = sendsByDayMap.get(key);
      const depositRow = depositsByDayMap.get(key);
      const withdrawalRow = withdrawalsByDayMap.get(key);
      const crossChainRow = crossChainByDayMap.get(key);

      // JS-summed across three already-per-day-aggregated SQL totals —
      // same "display value, not a ledger write" reasoning as
      // getMetrics()'s own totalFeesUsdc; no precision risk that matters
      // for a daily revenue chart.
      const feesUsdc =
        Number(sendRow?.fees_usdc ?? 0) + Number(withdrawalRow?.fees_usdc ?? 0) + Number(crossChainRow?.fees_usdc ?? 0);

      result.push({
        date: key,
        sendsCount: sendRow?.count ?? 0,
        depositsCount: depositRow?.count ?? 0,
        cryptoWithdrawalsCount: withdrawalRow?.count ?? 0,
        crossChainSendsCount: crossChainRow?.count ?? 0,
        sentUsdc: formatAmount(String(sendRow?.sent_usdc ?? "0")),
        depositedUsdc: formatAmount(String(depositRow?.deposited_usdc ?? "0")),
        withdrawnUsdc: formatAmount(String(withdrawalRow?.withdrawn_usdc ?? "0")),
        crossChainSentUsdc: formatAmount(String(crossChainRow?.sent_usdc ?? "0")),
        feesUsdc: formatAmount(String(feesUsdc)),
      });
    }
    return result;
  },

  // Debugging aid for "why didn't the fee reach treasury" reports — surfaces
  // each send's fee amount next to whatever the fee-sweep step actually
  // logged (success, failure, or "never got there"), instead of guessing
  // from the send's own state alone (PAYOUT_INITIATED/COMPLETE say nothing
  // about whether the *fee* sweep specifically succeeded — see
  // offramp/service.ts, where the fee sweep is a best-effort step separate
  // from the main payout).
  async listRecentSends(chain: string | undefined, limit: number): Promise<AdminSendDiagnostic[]> {
    const { rows } = await pool.query(
      `select s.id, s.chain, s.provider, s.amount_human, s.fee_amount, s.treasury_address, s.state,
              s.withdraw_tx_hash, s.created_at, s.provider_order_id,
              (
                select t.trigger from send_state_transitions t
                where t.send_id = s.id and t.trigger like 'fee_swe%'
                order by t.created_at desc limit 1
              ) as fee_sweep_trigger,
              (
                select t.created_at from send_state_transitions t
                where t.send_id = s.id and t.to_state = 'COMPLETE'
                order by t.created_at desc limit 1
              ) as completed_at,
              (
                select t.trigger from send_state_transitions t
                where t.send_id = s.id and t.to_state = 'COMPLETE'
                order by t.created_at desc limit 1
              ) as settlement_trigger
       from sends s
       where ($1::text is null or s.chain = $1)
       order by s.created_at desc
       limit $2`,
      [chain ?? null, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      chain: r.chain,
      provider: r.provider,
      amountHuman: r.amount_human,
      feeAmount: r.fee_amount,
      treasuryAddress: r.treasury_address,
      state: r.state,
      withdrawTxHash: r.withdraw_tx_hash,
      completedAt: r.completed_at,
      settlementTrigger: r.settlement_trigger,
      createdAt: r.created_at,
      feeSweepTrigger: r.fee_sweep_trigger,
      providerOrderId: r.provider_order_id,
    }));
  },

  // Same shape as listRecentSends, filtered to one user instead of one
  // chain — for tracing a specific "my balance looks wrong" report
  // against their actual send history, not just guessing from ledger
  // numbers alone.
  async listSendsForUser(userId: string, limit: number): Promise<AdminSendDiagnostic[]> {
    const { rows } = await pool.query(
      `select s.id, s.chain, s.provider, s.amount_human, s.fee_amount, s.treasury_address, s.state,
              s.withdraw_tx_hash, s.created_at, s.provider_order_id,
              (
                select t.trigger from send_state_transitions t
                where t.send_id = s.id and t.trigger like 'fee_swe%'
                order by t.created_at desc limit 1
              ) as fee_sweep_trigger,
              (
                select t.created_at from send_state_transitions t
                where t.send_id = s.id and t.to_state = 'COMPLETE'
                order by t.created_at desc limit 1
              ) as completed_at,
              (
                select t.trigger from send_state_transitions t
                where t.send_id = s.id and t.to_state = 'COMPLETE'
                order by t.created_at desc limit 1
              ) as settlement_trigger
       from sends s
       where s.user_id = $1
       order by s.created_at desc
       limit $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      chain: r.chain,
      provider: r.provider,
      amountHuman: r.amount_human,
      feeAmount: r.fee_amount,
      treasuryAddress: r.treasury_address,
      state: r.state,
      withdrawTxHash: r.withdraw_tx_hash,
      completedAt: r.completed_at,
      settlementTrigger: r.settlement_trigger,
      createdAt: r.created_at,
      feeSweepTrigger: r.fee_sweep_trigger,
      providerOrderId: r.provider_order_id,
    }));
  },

  // Finds every deposit that ever actually went through the
  // DEPOSIT_COMPLIANCE_SCREENING -> BALANCE_CREDITED transition more than
  // once — the definitive signature of the double-credit race just fixed
  // in stateMachine.ts's runScreening (a concurrent re-run of ingestDeposit
  // for the same deposit, crediting the ledger twice for one real
  // transaction). One-time audit surface to check whether any OTHER
  // deposit was hit by this before the fix, not just the one reported live.
  async findDoubleCreditedDeposits(): Promise<
    Array<{ depositId: string; creditCount: number; chain: string; txHash: string; userId: string; amount: string }>
  > {
    const { rows } = await pool.query(`
      select d.id as deposit_id, t.credit_count, d.chain, d.tx_hash, d.user_id, d.amount
      from deposits d
      join (
        select deposit_id, count(*) as credit_count
        from deposit_state_transitions
        where to_state = 'BALANCE_CREDITED'
        group by deposit_id
        having count(*) > 1
      ) t on t.deposit_id = d.id
      order by d.created_at desc
    `);
    return rows.map((r) => ({
      depositId: r.deposit_id,
      creditCount: Number(r.credit_count),
      chain: r.chain,
      txHash: r.tx_hash,
      userId: r.user_id,
      amount: r.amount,
    }));
  },

  // Read-only export for ops use (e.g. a one-off product-update or
  // feedback-request email) — deliberately just id/email/createdAt, not a
  // general "dump the users table" endpoint.
  async listUserEmails(): Promise<Array<{ id: string; email: string; createdAt: string }>> {
    const { rows } = await pool.query(
      `select id, email, created_at from users where email is not null and email <> '' order by created_at asc`,
    );
    return rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at }));
  },
};
