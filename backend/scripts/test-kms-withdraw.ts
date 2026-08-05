// Manual verification for the AWS KMS withdraw() implementation (Phase 2 of
// the self-custody migration) — sends a small REAL amount of USDC on Celo
// MAINNET from the designated payout wallet. Not part of any test
// suite/CI — run by hand:
//   npx tsx scripts/test-kms-withdraw.ts <amount>
//
// Before running: fund the payout wallet (printed below, also see
// AWS_KMS_PAYOUT_KEY_ARN in .env) with a little real CELO (gas) and at
// least <amount> USDC.
//
// The destination is a fresh throwaway KMS wallet created by this script
// (not an untracked address) — the test funds stay fully recoverable
// afterward, they're never sent somewhere nobody holds the key to.
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { env } from "../src/config/env.js";
import { awsKmsWalletAdapter } from "../src/domain/wallets/awsKmsAdapter.js";

async function main() {
  const amount = process.argv[2];
  if (!amount) {
    throw new Error("Usage: npx tsx scripts/test-kms-withdraw.ts <amount>  (e.g. 0.5)");
  }
  if (!env.awsKmsPayoutKeyArn) {
    throw new Error("Set AWS_KMS_PAYOUT_KEY_ARN in .env before running this script");
  }

  console.log("Creating a throwaway destination KMS wallet...");
  const destination = await awsKmsWalletAdapter.createWallet({
    userId: `phase2-verification-${Date.now()}`,
    email: null,
  });
  console.log("Destination:", destination.address);

  console.log(`Sending ${amount} USDC on Celo mainnet from the payout wallet to ${destination.address}...`);
  const result = await awsKmsWalletAdapter.withdraw({
    chain: "celo",
    tokenSymbol: "USDC",
    toAddress: destination.address,
    amount,
    reference: `phase2-verification-${Date.now()}`,
  });
  console.log("withdraw() returned:", result);

  if (!result.txHash) {
    throw new Error("withdraw() did not return a tx hash — nothing to verify");
  }

  console.log("Polling for the receipt (this is verification-only, withdraw() itself does not do this)...");
  const publicClient = createPublicClient({ chain: celo, transport: http(env.celoRpcUrl) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash as `0x${string}`, timeout: 120_000 });

  console.log(`Receipt status: ${receipt.status}`);
  if (receipt.status !== "success") {
    throw new Error(`FAILED: transaction reverted or was dropped (status=${receipt.status})`);
  }
  console.log(`OK: ${amount} USDC delivered to ${destination.address}. Celoscan: https://celoscan.io/tx/${result.txHash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
