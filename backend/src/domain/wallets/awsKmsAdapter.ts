import { KMSClient, CreateKeyCommand, CreateAliasCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";

function requireAwsConfig(): { region: string; accessKeyId: string; secretAccessKey: string } {
  if (!env.awsRegion || !env.awsAccessKeyId || !env.awsSecretAccessKey) {
    throw new Error("AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set when WALLET_PROVIDER=aws-kms");
  }
  return { region: env.awsRegion, accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey };
}

let cachedClient: KMSClient | null = null;
function kmsClient(): KMSClient {
  if (cachedClient) return cachedClient;
  const { region, accessKeyId, secretAccessKey } = requireAwsConfig();
  cachedClient = new KMSClient({ region, credentials: { accessKeyId, secretAccessKey } });
  return cachedClient;
}

// AWS's DER-encoded SPKI for an ECC_SECG_P256K1 public key is fixed-length
// (88 bytes: a constant OID prefix identifying the curve, plus the 65-byte
// uncompressed point) — so the raw point can be sliced off the tail without
// a full ASN.1 parser. Asserted below rather than assumed, since a wrong
// slice here would silently derive the wrong address.
function rawPointFromDerSpki(der: Uint8Array): Uint8Array {
  if (der.length !== 88) {
    throw new Error(`Unexpected KMS public key DER length: ${der.length} (expected 88 for ECC_SECG_P256K1)`);
  }
  const point = der.slice(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error("Unexpected KMS public key encoding: point is not uncompressed (0x04 prefix)");
  }
  return point;
}

// Standard EVM address derivation: keccak256 of the raw 64-byte X||Y
// (point with the 0x04 prefix stripped), last 20 bytes.
export function addressFromRawPoint(point: Uint8Array): string {
  const hash = keccak_256(point.slice(1));
  return `0x${Buffer.from(hash.slice(-20)).toString("hex")}`;
}

// docs.aws.amazon.com/kms — a KMS key never exposes its private key
// material; every signature is requested via the Sign API. One
// ECC_SECG_P256K1 key derives one address valid across every EVM chain
// (same curve, same address derivation everywhere), so multi-chain support
// doesn't require multiple keys per user — see the Phase 1 migration plan.
export const awsKmsWalletAdapter: WalletAdapter = {
  async createWallet({ userId }): Promise<CreatedWallet> {
    const client = kmsClient();

    const created = await client.send(
      new CreateKeyCommand({
        KeySpec: "ECC_SECG_P256K1",
        KeyUsage: "SIGN_VERIFY",
        Tags: [{ TagKey: "cowrypay-user-id", TagValue: userId }],
      }),
    );
    const keyArn = created.KeyMetadata?.Arn;
    const keyId = created.KeyMetadata?.KeyId;
    if (!keyArn || !keyId) {
      throw new Error("KMS CreateKey did not return a key ARN/ID");
    }

    await client.send(
      new CreateAliasCommand({
        AliasName: `alias/cowrypay-${userId}`,
        TargetKeyId: keyId,
      }),
    );

    const pub = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!pub.PublicKey) {
      throw new Error("KMS GetPublicKey did not return a public key");
    }
    const rawPoint = rawPointFromDerSpki(pub.PublicKey);
    const address = addressFromRawPoint(rawPoint);

    return {
      externalWalletId: keyArn,
      address,
      chain: env.defaultChain,
    };
  },

  async withdraw(_input: WithdrawInput): Promise<WithdrawResult> {
    throw new Error(
      "aws-kms withdraw is not implemented yet — Phase 1 only covers wallet creation, see the wallet-migration plan",
    );
  },
};
