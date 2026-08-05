// Manual verification for the AWS KMS wallet-creation adapter (Phase 1 of
// the self-custody migration). Not part of any test suite/CI — run by hand:
//   npx tsx scripts/test-kms-wallet.ts
//
// Creates one real KMS key, derives its address, then independently
// cross-checks the derivation by having KMS sign a digest and recovering
// the public key from the signature — the same recovery-id math a future
// Phase 2 (real transaction signing) will depend on. No blockchain
// interaction, no money movement.
import { randomUUID } from "node:crypto";
import { KMSClient, SignCommand, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { env } from "../src/config/env.js";
import { awsKmsWalletAdapter, addressFromRawPoint } from "../src/domain/wallets/awsKmsAdapter.js";

async function main() {
  if (!env.awsRegion || !env.awsAccessKeyId || !env.awsSecretAccessKey) {
    throw new Error("Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY before running this script");
  }

  const testUserId = randomUUID();
  console.log(`Creating a KMS wallet for throwaway test user ${testUserId}...`);
  const wallet = await awsKmsWalletAdapter.createWallet({ userId: testUserId, email: null });
  console.log("Created:", wallet);

  const client = new KMSClient({
    region: env.awsRegion,
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });

  // A stand-in for "the hash of an unsigned transaction" — Phase 2 will
  // pass a real keccak256(rlp(unsignedTx)) here instead of test data.
  const digest = keccak_256(new TextEncoder().encode("cowrypay-kms-phase1-verification"));

  console.log("Requesting a KMS signature over a test digest...");
  const signed = await client.send(
    new SignCommand({
      KeyId: wallet.externalWalletId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }),
  );
  if (!signed.Signature) throw new Error("KMS Sign did not return a signature");

  const sig = secp256k1.Signature.fromBytes(signed.Signature, "der");
  let recoveredAddress: string | null = null;
  for (const recoveryBit of [0, 1] as const) {
    try {
      const point = sig.addRecoveryBit(recoveryBit).recoverPublicKey(digest);
      const candidate = addressFromRawPoint(point.toBytes(false));
      if (candidate.toLowerCase() === wallet.address.toLowerCase()) {
        recoveredAddress = candidate;
        break;
      }
    } catch {
      // wrong recovery bit for this signature — try the other one
    }
  }

  if (!recoveredAddress) {
    throw new Error(
      `FAILED: could not recover address ${wallet.address} from the KMS signature under either recovery bit`,
    );
  }
  console.log(`OK: recovered address ${recoveredAddress} matches the derived wallet address.`);

  console.log("Scheduling deletion of the throwaway test key (7-day minimum waiting period, AWS default)...");
  await client.send(new ScheduleKeyDeletionCommand({ KeyId: wallet.externalWalletId }));
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
