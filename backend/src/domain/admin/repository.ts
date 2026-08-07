import { pool } from "../../db/pool.js";
import { formatAmount } from "../../utils/format.js";

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
};
