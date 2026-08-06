import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { generateKeyPair, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { env } from "../../config/env.js";

function requireSolanaKmsConfig(): string {
  if (!env.solanaKmsKeyArn) {
    throw new Error("SOLANA_KMS_KEY_ARN must be set to encrypt/decrypt Solana signing keys");
  }
  return env.solanaKmsKeyArn;
}

let cachedClient: KMSClient | null = null;
function kmsClient(): KMSClient {
  if (cachedClient) return cachedClient;
  if (!env.awsRegion || !env.awsAccessKeyId || !env.awsSecretAccessKey) {
    throw new Error("AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to use Solana KMS encryption");
  }
  cachedClient = new KMSClient({
    region: env.awsRegion,
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });
  return cachedClient;
}

// An Ed25519 private key's PKCS8 DER export is a fixed 16-byte header
// followed by the raw 32-byte seed (48 bytes total) — empirically verified
// against real Node WebCrypto output, not just assumed from the RFC.
// Concatenated with the 32-byte raw public key, this is the conventional
// 64-byte Solana secret-key format createKeyPairSignerFromBytes expects.
const PKCS8_ED25519_HEADER_LENGTH = 16;

async function keyPairToSecretKeyBytes(publicKey: CryptoKey, privateKey: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const rawSeed = pkcs8.slice(PKCS8_ED25519_HEADER_LENGTH);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const secretKey64 = new Uint8Array(64);
  secretKey64.set(rawSeed, 0);
  secretKey64.set(rawPublic, 32);
  return secretKey64;
}

// Generates a brand-new Solana keypair and immediately encrypts it — the
// plaintext secret key only ever exists in this process's memory for the
// duration of this one call. `generateKeyPair(true)` is required, not the
// default: @solana/keys' generateKeyPair defaults extractable to false
// (confirmed against its source this session), which would make the
// private key impossible to export at all.
export async function generateAndEncryptSolanaKeyPair(): Promise<{ address: string; ciphertext: string }> {
  const { publicKey, privateKey } = await generateKeyPair(true);
  const secretKey64 = await keyPairToSecretKeyBytes(publicKey, privateKey);
  const signer = await createKeyPairSignerFromBytes(secretKey64);
  const ciphertext = await encryptSolanaSecretKey(secretKey64);
  return { address: signer.address, ciphertext };
}

export async function encryptSolanaSecretKey(secretKey64: Uint8Array): Promise<string> {
  const keyArn = requireSolanaKmsConfig();
  const { CiphertextBlob } = await kmsClient().send(
    new EncryptCommand({ KeyId: keyArn, Plaintext: Buffer.from(secretKey64) }),
  );
  if (!CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext for a Solana signing key");
  return Buffer.from(CiphertextBlob).toString("base64");
}

// Deliberately NOT cached — unlike Stellar's single shared-account signer,
// every call here may be decrypting a different user's key. Caching one
// signer at module scope would silently leak/reuse the wrong user's key on
// the next call.
export async function decryptSolanaSigner(ciphertext: string): Promise<KeyPairSigner> {
  const keyArn = requireSolanaKmsConfig();
  const { Plaintext } = await kmsClient().send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, "base64"), KeyId: keyArn }),
  );
  if (!Plaintext) throw new Error("KMS Decrypt returned no plaintext for a Solana signing key");
  return createKeyPairSignerFromBytes(new Uint8Array(Plaintext));
}

// Thin wrapper specifically for the one treasury key — unlike per-user
// seeds, there's only ever one of these, so caching after first decrypt is
// safe and mirrors stellarKms.ts's getStellarSigningKeypair() exactly.
let cachedTreasurySigner: KeyPairSigner | null = null;
export async function getSolanaTreasurySigner(): Promise<KeyPairSigner> {
  if (cachedTreasurySigner) return cachedTreasurySigner;
  if (!env.solanaTreasurySigningKeyCiphertext) {
    throw new Error("SOLANA_TREASURY_SIGNING_KEY_CIPHERTEXT must be set to sign Solana treasury transactions");
  }
  cachedTreasurySigner = await decryptSolanaSigner(env.solanaTreasurySigningKeyCiphertext);
  return cachedTreasurySigner;
}
