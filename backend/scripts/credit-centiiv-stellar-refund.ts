import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
import { Pool, type PoolClient } from "pg";

// One-off remediation for a Centiiv/Stellar off-ramp send that Centiiv
// genuinely refunded on-chain, but centiivSettlementPoller.ts never
// auto-credited because verifyStellarRefund() only recognises classic
// `payment` operations — Centiiv refunds on Stellar via a Soroban
// contract call (`execute_refund_transfer`), which Horizon reports as an
// `invoke_host_function` op with the transfer under `asset_balance_changes`
// (see refundVerification.ts, now fixed). This does, by hand, exactly
// what applyTerminalFailureTransition(client, send, "REFUNDED", ...,
// { txHash }) would have done: guarded state -> REFUNDED, credit
// amount_human back to the ledger, log the transition, and pre-register
// the refund tx as an already-credited deposit so nothing double-credits
// it later.
//
// Standalone on purpose (only needs DATABASE_URL), same as migrate.ts.
// Dry-run by default; pass --apply to write.

setDefaultResultOrder("ipv4first");

// Same pinned root CA as src/db/pool.ts / scripts/migrate.ts — keep in
// sync if it's ever rotated.
const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

// The send's own payout leg (treasury -> Centiiv temp wallet). Stored on
// the sends row as withdraw_tx_hash.
const PAYOUT_TX_HASH = "1161b2521bcf57b4a0f43e036bf299892fb0e8308204d5b7837acadbfacc9bff";
// Centiiv's on-chain refund back to the Stellar omnibus treasury, verified
// on Horizon: invoke_host_function `execute_refund_transfer`, 9.9 USDC
// GDAZVM5Z...(Centiiv) -> GBCPVOCO...(STELLAR_DEPOSIT_ADDRESS), 2026-09-08
// 08:36:51Z, 67s after the payout above.
const REFUND_TX_HASH = "5eb2fef8d7b50e87bd5c9dde95d6947dfb38f354b2e5be95925be9344c89b2ca";

const ACTOR = "manual_fix";
const NOTE = `status:REFUNDED (verifyStellarRefund missed the Soroban refund op; verified by hand on-chain: ${REFUND_TX_HASH})`;

const apply = process.argv.includes("--apply");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL !== "false" ? { rejectUnauthorized: true, ca: SUPABASE_ROOT_CA } : undefined,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 10_000,
});

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const { rows: sendRows } = await pool.query(`select * from sends where withdraw_tx_hash = $1`, [PAYOUT_TX_HASH]);
  if (sendRows.length === 0) throw new Error(`no send found with withdraw_tx_hash ${PAYOUT_TX_HASH}`);
  if (sendRows.length > 1) throw new Error(`multiple sends found with withdraw_tx_hash ${PAYOUT_TX_HASH} — investigate manually`);
  const send = sendRows[0];

  const { rows: transitions } = await pool.query(
    `select from_state, to_state, trigger, actor, created_at from send_state_transitions where send_id = $1 order by created_at asc`,
    [send.id],
  );
  const { rows: balances } = await pool.query(
    `select chain, token_symbol, available_balance, pending_balance from ledger_balances where user_id = $1`,
    [send.user_id],
  );
  const { rows: existingRefundDeposit } = await pool.query(
    `select id, state, amount, created_at from deposits where chain = $1 and tx_hash = $2`,
    [send.chain, REFUND_TX_HASH],
  );

  console.log("=== send ===");
  console.log({
    id: send.id,
    user_id: send.user_id,
    wallet_id: send.wallet_id,
    chain: send.chain,
    token_symbol: send.token_symbol,
    amount_human: send.amount_human,
    fee_amount: send.fee_amount,
    fiat_currency: send.fiat_currency,
    provider: send.provider,
    provider_order_id: send.provider_order_id,
    state: send.state,
    reference: send.reference,
    created_at: send.created_at,
  });
  console.log("=== transitions ===");
  for (const t of transitions) console.log(`${t.created_at.toISOString?.() ?? t.created_at}  ${t.from_state ?? "∅"} -> ${t.to_state}  [${t.actor}] ${t.trigger}`);
  console.log("=== user ledger balances ===");
  for (const b of balances) console.log(`${b.chain} ${b.token_symbol}: available=${b.available_balance} pending=${b.pending_balance}`);
  console.log("=== existing deposit row for refund tx ===");
  console.log(existingRefundDeposit.length ? existingRefundDeposit[0] : "(none)");

  // Guards
  const problems: string[] = [];
  if (send.provider !== "centiiv") problems.push(`provider is "${send.provider}", expected "centiiv"`);
  if (String(send.chain).toLowerCase() !== "stellar") problems.push(`chain is "${send.chain}", expected "stellar"`);
  if (send.state === "REFUNDED" || send.state === "FAILED") problems.push(`send is already terminal (${send.state}) — user was already credited; nothing to do`);
  if (send.state === "COMPLETE") problems.push(`send is COMPLETE — reviving it needs /admin/sends/:id/correct-state (which reverses the credit), not this script`);
  if (problems.length) {
    console.log("\n=== NOT SAFE TO APPLY ===");
    for (const p of problems) console.log(` - ${p}`);
    return;
  }

  const creditAmount: string = send.amount_human; // full original debit, fee included — same policy as applyTerminalFailureTransition
  console.log(`\nPlanned change: state ${send.state} -> REFUNDED, credit ${creditAmount} ${send.token_symbol} on ${send.chain} to user ${send.user_id}`);

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  await withTransaction(async (client) => {
    // Guarded state transition — only proceeds if the row is still in the
    // state we just read (mirrors sendsRepo.updateStateIfCurrent).
    const { rows: updated } = await client.query(
      `update sends set state = 'REFUNDED', updated_at = now() where id = $1 and state = $2 returning id`,
      [send.id, send.state],
    );
    if (updated.length === 0) throw new Error(`send ${send.id} is no longer in state ${send.state} — aborting, another process moved it`);

    const { rows: creditRows } = await client.query(
      `insert into ledger_balances (user_id, token_symbol, chain, available_balance)
       values ($1, $2, $3, $4)
       on conflict (user_id, token_symbol, chain)
       do update set available_balance = ledger_balances.available_balance + excluded.available_balance, updated_at = now()
       returning available_balance`,
      [send.user_id, send.token_symbol, send.chain, creditAmount],
    );

    await client.query(
      `insert into send_state_transitions (send_id, from_state, to_state, trigger, actor) values ($1, $2, 'REFUNDED', $3, $4)`,
      [send.id, send.state, NOTE, ACTOR],
    );

    // Pre-register the refund tx as an already-credited deposit so the
    // deposit scanner can never re-credit it (mirrors
    // applyTerminalFailureTransition's providerRefundOnChain branch).
    const { rows: inserted } = await client.query(
      `insert into deposits (user_id, wallet_id, token_symbol, amount, chain, tx_hash)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (chain, tx_hash) do nothing
       returning id`,
      [send.user_id, send.wallet_id, send.token_symbol, send.amount_human, send.chain, REFUND_TX_HASH],
    );
    if (inserted.length > 0) {
      await client.query(`update deposits set state = 'BALANCE_CREDITED', updated_at = now() where id = $1`, [inserted[0].id]);
      await client.query(
        `insert into deposit_state_transitions (deposit_id, from_state, to_state, trigger, actor)
         values ($1, 'DEPOSIT_DETECTED', 'BALANCE_CREDITED', $2, $3)`,
        [inserted[0].id, `provider_refund_already_credited_via_send:${send.id}`, ACTOR],
      );
    }

    console.log(`\nAPPLIED. New available balance for ${send.chain} ${send.token_symbol}: ${creditRows[0].available_balance}`);
    console.log(inserted.length > 0 ? "Refund tx registered as BALANCE_CREDITED deposit." : "Refund tx deposit row already existed — left as-is.");
  });
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
