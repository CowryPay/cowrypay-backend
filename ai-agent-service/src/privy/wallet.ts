import { PrivyClient } from "@privy-io/server-auth";
import { db } from "../db/index.js";
import type { TxPayload, PrivyWallet } from "../types.js";
import { encodeRegisterUsername } from "../chain/encodeUserRegistry.js";
import { normalizeUsernameForRegistry } from "../chain/normalizeUsername.js";

// @privy-io/server-auth v1: positional (appId, appSecret) constructor
const privy = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!,
);

const CAIP2 = `eip155:${process.env.MONAD_CHAIN_ID ?? "10143"}` as `eip155:${string}`;

// ── Create a new server-side EVM wallet for a phone number ───────────────────
export async function createPrivyWallet(phone: string): Promise<PrivyWallet> {
  const wallet = await privy.walletApi.createWallet({
    chainType: "ethereum",                   // EVM-compatible — works on Monad
    idempotencyKey: `wallet-${phone}`,       // ensures one wallet per phone even if called twice
  });

  await db.savePrivyWalletId(phone, wallet.id);

  return { id: wallet.id, address: wallet.address };
}

// ── Get existing wallet ID from DB ────────────────────────────────────────────
export async function getPrivyWalletId(phone: string): Promise<string | null> {
  return db.getPrivyWalletId(phone);
}

// ── Fetch a Privy wallet record by its ID (used for admin restore) ────────────
export async function getPrivyWallet(walletId: string): Promise<PrivyWallet> {
  const wallet = await privy.walletApi.getWallet({ id: walletId });
  return { id: wallet.id, address: wallet.address };
}

// ── Sign and broadcast a transaction ─────────────────────────────────────────
// Called ONLY after user replies YES in WhatsApp.
// If txPayload.gasLimit is set we pass it explicitly; otherwise Privy estimates.
export async function signAndBroadcast(
  phone: string,
  txPayload: TxPayload,
): Promise<string> {
  const walletId = await db.getPrivyWalletId(phone);
  if (!walletId) throw new Error("No wallet found. Please sign up first.");

  const { hash } = await privy.walletApi.ethereum.sendTransaction({
    walletId,
    caip2: CAIP2,
    transaction: {
      to:    txPayload.to    as `0x${string}`,
      data:  txPayload.data  as `0x${string}`,
      value: txPayload.value as `0x${string}`,
      ...(txPayload.gasLimit           !== undefined && { gasLimit:           `0x${txPayload.gasLimit.toString(16)}`           as `0x${string}` }),
      ...(txPayload.maxFeePerGas       !== undefined && { maxFeePerGas:       `0x${txPayload.maxFeePerGas.toString(16)}`       as `0x${string}` }),
      ...(txPayload.maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas: `0x${txPayload.maxPriorityFeePerGas.toString(16)}` as `0x${string}` }),
    },
  });

  return hash;
}

// ── Sign and broadcast on a specific EVM chain (for LI.FI yield deposits) ────
// Unlike signAndBroadcast (which is hardcoded to Monad), this accepts any chainId.
export async function signAndBroadcastOnChain(
  phone: string,
  txPayload: TxPayload,
  chainId: number,
): Promise<string> {
  const walletId = await db.getPrivyWalletId(phone);
  if (!walletId) throw new Error("No wallet found. Please sign up first.");

  const caip2 = `eip155:${chainId}` as `eip155:${string}`;

  const { hash } = await privy.walletApi.ethereum.sendTransaction({
    walletId,
    caip2,
    transaction: {
      to:    txPayload.to    as `0x${string}`,
      data:  txPayload.data  as `0x${string}`,
      value: txPayload.value as `0x${string}`,
      ...(txPayload.gasLimit             !== undefined && { gasLimit:             `0x${txPayload.gasLimit.toString(16)}`             as `0x${string}` }),
      ...(txPayload.maxFeePerGas         !== undefined && { maxFeePerGas:         `0x${txPayload.maxFeePerGas.toString(16)}`         as `0x${string}` }),
      ...(txPayload.maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas: `0x${txPayload.maxPriorityFeePerGas.toString(16)}` as `0x${string}` }),
    },
  });

  return hash;
}

// ── Register username on-chain after signup ───────────────────────────────────
// The user's Privy wallet calls UsernameRegistry.register()
export async function registerUsernameOnChain(
  phone: string,
  username: string,
  _walletAddress: string,
  gasOverrides?: Pick<TxPayload, "gasLimit" | "maxFeePerGas" | "maxPriorityFeePerGas">,
): Promise<string> {
  const walletId = await db.getPrivyWalletId(phone);
  if (!walletId) throw new Error("No wallet found.");

  const norm = normalizeUsernameForRegistry(username);
  if (!norm.ok) throw new Error(norm.reason);

  const encoded = encodeRegisterUsername(norm.name);

  const { hash } = await privy.walletApi.ethereum.sendTransaction({
    walletId,
    caip2: CAIP2,
    transaction: {
      to:    encoded.to,
      data:  encoded.data,
      value: encoded.value as `0x${string}`,
      ...(gasOverrides?.gasLimit           !== undefined && { gasLimit:           `0x${gasOverrides.gasLimit.toString(16)}`           as `0x${string}` }),
      ...(gasOverrides?.maxFeePerGas       !== undefined && { maxFeePerGas:       `0x${gasOverrides.maxFeePerGas.toString(16)}`       as `0x${string}` }),
      ...(gasOverrides?.maxPriorityFeePerGas !== undefined && { maxPriorityFeePerGas: `0x${gasOverrides.maxPriorityFeePerGas.toString(16)}` as `0x${string}` }),
    },
  });

  return hash;
}
