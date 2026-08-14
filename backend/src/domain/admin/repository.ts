import { pool } from "../../db/pool.js";
import { formatAmount } from "../../utils/format.js";

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
    byChain: { chain: string; sends: number; deposits: number }[];
  };
  // Only settled amounts (sends: COMPLETE, deposits: BALANCE_CREDITED) —
  // volume from failed/pending attempts isn't real on-chain volume.
  onChainVolume: {
    sentUsdc: string;
    depositedUsdc: string;
    byChain: { chain: string; sentUsdc: string; depositedUsdc: string }[];
  };
  // Platform fee actually captured on settled sends only — a fee swept
  // from a send that later gets refunded/fails isn't real revenue (see
  // offramp/service.ts's fee-sweep step, which runs on broadcast, before
  // Paycrest's final settlement confirms).
  revenue: {
    totalFeesUsdc: string;
    byChain: { chain: string; feesUsdc: string }[];
  };
}

export interface AdminMetricsDay {
  date: string; // YYYY-MM-DD
  sendsCount: number;
  depositsCount: number;
  sentUsdc: string;
  depositedUsdc: string;
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
      sendsByChain,
      depositsByChain,
      volumeSentByChain,
      volumeDepositedByChain,
      revenueByChain,
      totalSent,
      totalDeposited,
      totalFees,
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
      pool.query(`select chain, count(*)::int as count from sends group by chain order by chain`),
      pool.query(`select chain, count(*)::int as count from deposits group by chain order by chain`),
      pool.query(
        `select chain, coalesce(sum(amount_human), 0) as total from sends where state = 'COMPLETE' group by chain order by chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(amount), 0) as total from deposits where state = 'BALANCE_CREDITED' group by chain order by chain`,
      ),
      pool.query(
        `select chain, coalesce(sum(fee_amount), 0) as total from sends where state = 'COMPLETE' group by chain order by chain`,
      ),
      // Summed once more directly in SQL rather than adding up the
      // per-chain numeric strings above in JS — a Number() round-trip on
      // money is exactly what formatAmount's own doc comment (and every
      // ledger write in this codebase) deliberately avoids.
      pool.query(`select coalesce(sum(amount_human), 0) as total from sends where state = 'COMPLETE'`),
      pool.query(`select coalesce(sum(amount), 0) as total from deposits where state = 'BALANCE_CREDITED'`),
      pool.query(`select coalesce(sum(fee_amount), 0) as total from sends where state = 'COMPLETE'`),
    ]);

    // sends/deposits per-chain counts and sent/deposited volume are each
    // separate group-by queries (different tables, different filters) —
    // merged here into one row per chain rather than forcing a single SQL
    // query to outer-join three independently-shaped aggregates.
    const chains = new Set<string>([
      ...sendsByChain.rows.map((r) => r.chain),
      ...depositsByChain.rows.map((r) => r.chain),
    ]);
    const sendsByChainMap = new Map(sendsByChain.rows.map((r) => [r.chain, r.count]));
    const depositsByChainMap = new Map(depositsByChain.rows.map((r) => [r.chain, r.count]));
    const sentVolumeByChainMap = new Map(volumeSentByChain.rows.map((r) => [r.chain, r.total]));
    const depositedVolumeByChainMap = new Map(volumeDepositedByChain.rows.map((r) => [r.chain, r.total]));
    const revenueByChainMap = new Map(revenueByChain.rows.map((r) => [r.chain, r.total]));

    const byChain = [...chains].sort().map((chain) => ({
      chain,
      sends: sendsByChainMap.get(chain) ?? 0,
      deposits: depositsByChainMap.get(chain) ?? 0,
    }));

    const volumeByChain = [...chains].sort().map((chain) => ({
      chain,
      sentUsdc: formatAmount(String(sentVolumeByChainMap.get(chain) ?? "0")),
      depositedUsdc: formatAmount(String(depositedVolumeByChainMap.get(chain) ?? "0")),
    }));

    const revenueChainBreakdown = [...revenueByChainMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([chain, total]) => ({ chain, feesUsdc: formatAmount(String(total)) }));

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
        byChain,
      },
      onChainVolume: {
        sentUsdc: formatAmount(String(totalSent.rows[0].total)),
        depositedUsdc: formatAmount(String(totalDeposited.rows[0].total)),
        byChain: volumeByChain,
      },
      revenue: {
        totalFeesUsdc: formatAmount(String(totalFees.rows[0].total)),
        byChain: revenueChainBreakdown,
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
    const [sendsByDay, depositsByDay] = await Promise.all([
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
    ]);

    const sendsByDayMap = new Map(sendsByDay.rows.map((r) => [dayKey(r.day), r]));
    const depositsByDayMap = new Map(depositsByDay.rows.map((r) => [dayKey(r.day), r]));

    const result: AdminMetricsDay[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);

      const sendRow = sendsByDayMap.get(key);
      const depositRow = depositsByDayMap.get(key);

      result.push({
        date: key,
        sendsCount: sendRow?.count ?? 0,
        depositsCount: depositRow?.count ?? 0,
        sentUsdc: formatAmount(String(sendRow?.sent_usdc ?? "0")),
        depositedUsdc: formatAmount(String(depositRow?.deposited_usdc ?? "0")),
        feesUsdc: formatAmount(String(sendRow?.fees_usdc ?? "0")),
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
};
