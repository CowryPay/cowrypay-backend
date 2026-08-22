import { KMSClient, CreateKeyCommand, CreateAliasCommand, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { toAccount } from "viem/accounts";
import {
  createWalletClient,
  http,
  serializeTransaction,
  keccak256,
  numberToHex,
  encodeFunctionData,
  parseUnits,
  parseEther,
} from "viem";
import { env } from "../../config/env.js";
import { getChainConfig, getTokenConfig } from "./chains.js";
import { PayoutLiquidityError, type CreatedWallet, type WalletAdapter, type WithdrawInput, type WithdrawResult } from "./adapter.js";
import { claimNonce, resyncNonce, isNonceError, fetchPendingNonce } from "./evmNonce.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";

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
export function addressFromRawPoint(point: Uint8Array): `0x${string}` {
  const hash = keccak_256(point.slice(1));
  return `0x${Buffer.from(hash.slice(-20)).toString("hex")}`;
}

async function fetchAddressForKey(client: KMSClient, keyId: string): Promise<`0x${string}`> {
  const pub = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pub.PublicKey) {
    throw new Error("KMS GetPublicKey did not return a public key");
  }
  return addressFromRawPoint(rawPointFromDerSpki(pub.PublicKey));
}

// Public wrapper around fetchAddressForKey — depositSweeper.ts needs the
// payout key's own address (to build its signing account and as the sweep
// destination) without reaching into this module's private KMS client
// management.
export async function getWalletAddress(keyArn: string): Promise<`0x${string}`> {
  return fetchAddressForKey(kmsClient(), keyArn);
}

// secp256k1's curve order — a public, standard constant (the same curve
// Bitcoin/Ethereum use), needed to normalize a KMS signature into the
// low-S form EVM chains require (EIP-2). KMS doesn't guarantee low-S.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// KMS never exposes r/s/recovery directly — just a DER-encoded (r, s) pair
// with no recovery bit. Both are recovered here the same way Phase 1's
// verification script proved out: normalize to low-S by hand (negating s
// invalidates whichever recovery bit was implicit, so it's re-derived
// fresh below rather than inferred), then try both candidate recovery
// bits against the digest and keep whichever recovers back to this key's
// known address.
async function kmsSignDigest(
  client: KMSClient,
  keyArn: string,
  digest: Uint8Array,
  expectedAddress: `0x${string}`,
): Promise<{ r: bigint; s: bigint; recovery: 0 | 1 }> {
  const signed = await client.send(
    new SignCommand({
      KeyId: keyArn,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }),
  );
  if (!signed.Signature) {
    throw new Error("KMS Sign did not return a signature");
  }

  let sig = secp256k1.Signature.fromBytes(signed.Signature, "der");
  if (sig.hasHighS()) {
    sig = new secp256k1.Signature(sig.r, SECP256K1_N - sig.s);
  }

  for (const recovery of [0, 1] as const) {
    const point = sig.addRecoveryBit(recovery).recoverPublicKey(digest);
    const candidate = addressFromRawPoint(point.toBytes(false));
    if (candidate.toLowerCase() === expectedAddress.toLowerCase()) {
      return { r: sig.r, s: sig.s, recovery };
    }
  }
  throw new Error(`Could not determine the recovery bit for a KMS signature (key ${keyArn})`);
}

// The documented viem pattern for HSM/KMS-backed signing: a "Custom
// Account" whose signTransaction implementation is supplied by us. viem
// still owns transaction building (nonce/gas/serialization) — it just
// never sees a private key; the digest goes to KMS and the signature
// comes back, mirroring exactly how viem's own privateKeyToAccount signs
// (see node_modules/viem/accounts/utils/sign.ts), with KMS standing in
// for the local secp256k1.sign call.
// Exported for reuse by anything that needs to sign from a KMS key other
// than the fixed payout key (e.g. depositSweeper.ts, which signs from each
// user's own deposit-address key) — withdraw() below is just one caller.
export function kmsAccountFromKey(keyArn: string, address: `0x${string}`) {
  return toAccount({
    address,
    async signTransaction(transaction, opts) {
      const client = kmsClient();
      const serializer = opts?.serializer ?? serializeTransaction;
      const unsignedSerialized = await serializer(transaction);
      const digest = keccak256(unsignedSerialized, "bytes");
      const { r, s, recovery } = await kmsSignDigest(client, keyArn, digest, address);
      const signature = {
        r: numberToHex(r, { size: 32 }),
        s: numberToHex(s, { size: 32 }),
        v: recovery ? 28n : 27n,
        yParity: recovery,
      };
      return serializer(transaction, signature);
    },
    async signMessage() {
      throw new Error("aws-kms account: message signing not supported (transactions only)");
    },
    async signTypedData() {
      throw new Error("aws-kms account: typed-data signing not supported (transactions only)");
    },
  });
}

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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

    const address = await fetchAddressForKey(client, keyId);

    return {
      externalWalletId: keyArn,
      address,
      chain: env.defaultChain,
    };
  },

  // Phase 2/6: real signing + broadcasting, for any token/chain pair listed
  // in chains.ts's per-chain token map (getTokenConfig throws clearly for
  // anything else — e.g. USDT on Base). Pays out from a single designated
  // KMS key (AWS_KMS_PAYOUT_KEY_ARN) rather than per-user signing — mirrors
  // Blockradar's own master-wallet model today (one wallet, pooled by
  // auto-sweep, pays every send out), avoiding nonce-management complexity
  // across many keys. Note: this makes withdraw() mechanically capable of
  // paying out on any supported chain, but nothing here decides *which*
  // chain to use when the payout key's balance is fragmented across
  // several — that's the caller's call (currently always wallet.chain —
  // see the Phase 6 plan).
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    if (!env.awsKmsPayoutKeyArn) {
      throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set when WALLET_PROVIDER=aws-kms");
    }
    const { viemChain, rpcUrl } = getChainConfig(input.chain);
    const { address: tokenAddress, decimals: tokenDecimals } = getTokenConfig(input.chain, input.tokenSymbol);

    const client = kmsClient();
    const payoutAddress = await fetchAddressForKey(client, env.awsKmsPayoutKeyArn);
    const account = kmsAccountFromKey(env.awsKmsPayoutKeyArn, payoutAddress);

    const walletClient = createWalletClient({
      account,
      chain: viemChain,
      transport: http(rpcUrl),
    });
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [input.toAddress as `0x${string}`, parseUnits(input.amount, tokenDecimals)],
    });

    const fetchFreshNonce = fetchPendingNonce(viemChain, rpcUrl, payoutAddress);

    // Broadcast and return immediately — do NOT block on a receipt here.
    // The double-spend bug this codebase already hit once
    // (blockradarAdapter.ts) came from treating an ambiguous pending state
    // as a failure; waiting on confirmation inside withdraw() risks the
    // same mistake in a new shape (a receipt-poll timeout looking like a
    // failure while the transaction actually lands). Revert/confirmation
    // checking is deliberately deferred — see the Phase 2 plan.
    async function send(nonce: number): Promise<`0x${string}`> {
      return walletClient.sendTransaction({ to: tokenAddress, data, value: 0n, nonce });
    }

    let txHash: `0x${string}`;
    try {
      // Cross-process safety net around evmNonce.ts's in-memory cache —
      // see advisoryLock.ts's own comment for why this exists. Scoped per
      // chain, same lock key depositSweeper.ts's gas top-up uses, since
      // both send from this same payout wallet and must exclude each
      // other too, not just other withdraw() calls.
      txHash = await withAdvisoryLock(`evm-nonce:${input.chain}`, async () => {
        const nonce = await claimNonce(input.chain, fetchFreshNonce);
        try {
          return await send(nonce);
        } catch (err) {
          // The in-memory nonce cache turned out to be wrong (first use
          // after a restart racing an old transaction, or truly out-of-band
          // activity on this key) — resync from the chain and retry exactly
          // once with a freshly-fetched nonce before giving up.
          if (!isNonceError(err)) throw err;
          resyncNonce(input.chain);
          const freshNonce = await claimNonce(input.chain, fetchFreshNonce);
          return await send(freshNonce);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The user's own ledger balance was already checked and atomically
      // debited before this call (see PayoutLiquidityError's own doc
      // comment) — a revert with this specific reason means the payout
      // wallet itself is short on this chain's USDC, an operational
      // liquidity problem on our side, not the user's.
      if (message.includes("transfer amount exceeds balance")) {
        console.error(
          `[aws-kms withdraw] payout wallet ${payoutAddress} is short on USDC on ${input.chain} — needs topping up. Attempted amount: ${input.amount}`,
        );
        throw new PayoutLiquidityError(
          "We're temporarily unable to complete this transfer due to a system issue on our end — your balance is unaffected. Please try again shortly, or contact support if it persists.",
        );
      }
      throw err;
    }

    return { txHash, status: "PENDING" };
  },
};

// One-off ops tool for moving the payout wallet's own NATIVE gas token
// (CELO/ETH, not USDC/USDT) to another address — e.g. topping up gas on a
// different wallet the operator controls. Deliberately separate from
// WalletAdapter.withdraw() above (which is USDC/USDT-only, per
// WithdrawInput's tokenSymbol) rather than overloading it, since a native
// transfer has no token contract or decimals lookup at all — but it goes
// through the EXACT same nonce-claiming path (claimNonce/resyncNonce
// inside the same evm-nonce:<chain> advisory lock) as every real payout
// from this wallet, for the same reason withdraw() does: an independent
// script signing its own transaction would read the chain's nonce outside
// that lock and could collide with a concurrent real send.
export async function sendNativeToken(chain: string, toAddress: `0x${string}`, amountEther: string): Promise<`0x${string}`> {
  if (!env.awsKmsPayoutKeyArn) {
    throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set when WALLET_PROVIDER=aws-kms");
  }
  const { viemChain, rpcUrl } = getChainConfig(chain);

  const client = kmsClient();
  const payoutAddress = await fetchAddressForKey(client, env.awsKmsPayoutKeyArn);
  const account = kmsAccountFromKey(env.awsKmsPayoutKeyArn, payoutAddress);

  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
  const value = parseEther(amountEther);

  const fetchFreshNonce = fetchPendingNonce(viemChain, rpcUrl, payoutAddress);

  async function send(nonce: number): Promise<`0x${string}`> {
    return walletClient.sendTransaction({ to: toAddress, value, nonce });
  }

  return withAdvisoryLock(`evm-nonce:${chain}`, async () => {
    const nonce = await claimNonce(chain, fetchFreshNonce);
    try {
      return await send(nonce);
    } catch (err) {
      if (!isNonceError(err)) throw err;
      resyncNonce(chain);
      const freshNonce = await claimNonce(chain, fetchFreshNonce);
      return await send(freshNonce);
    }
  });
}
