import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { Keypair } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";

function requireStellarKmsConfig(): { keyArn: string; ciphertext: string } {
  if (!env.stellarKmsKeyArn || !env.stellarSigningKeyCiphertext) {
    throw new Error("STELLAR_KMS_KEY_ARN and STELLAR_SIGNING_KEY_CIPHERTEXT must be set to sign Stellar withdrawals");
  }
  return { keyArn: env.stellarKmsKeyArn, ciphertext: env.stellarSigningKeyCiphertext };
}

let cachedClient: KMSClient | null = null;
function kmsClient(): KMSClient {
  if (cachedClient) return cachedClient;
  if (!env.awsRegion || !env.awsAccessKeyId || !env.awsSecretAccessKey) {
    throw new Error("AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to decrypt the Stellar signing key");
  }
  cachedClient = new KMSClient({
    region: env.awsRegion,
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });
  return cachedClient;
}

// IMPORTANT trust-model note, deliberately different from awsKmsAdapter.ts:
// there, the EVM private key never leaves KMS — every signature is a KMS
// Sign API call, and the key material itself is never retrievable. Here, it
// genuinely can't work that way, because AWS KMS has no Ed25519 KeySpec at
// all (only RSA/ECC-NIST/secp256k1) and Stellar signs exclusively with
// Ed25519. So this decrypts the real plaintext secret seed into process
// memory and keeps it there for the process's lifetime (cached below) — KMS
// only protects the seed at rest (env var / wherever the ciphertext is
// stored), not in use. This is the accepted tradeoff behind the explicit
// "encrypted seed, decrypted in-memory to sign" custody decision for
// Stellar — never assume this adapter has the same key-never-leaves-KMS
// guarantee the EVM one does.
let cachedKeypair: Keypair | null = null;
export async function getStellarSigningKeypair(): Promise<Keypair> {
  if (cachedKeypair) return cachedKeypair;

  const { keyArn, ciphertext } = requireStellarKmsConfig();
  const { Plaintext } = await kmsClient().send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, "base64"), KeyId: keyArn }),
  );
  if (!Plaintext) throw new Error("KMS Decrypt returned no plaintext for the Stellar signing key");

  const secret = Buffer.from(Plaintext).toString("utf8");
  cachedKeypair = Keypair.fromSecret(secret);
  return cachedKeypair;
}
