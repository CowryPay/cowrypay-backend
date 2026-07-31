import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { env } from "../../config/env.js";

// Narrow, structural interfaces covering only the methods actually used
// here — viem's real PublicClient/WalletClient generic types are
// parameterized by chain/transport/account in ways that fight TS's
// inference/serialization when hand-annotated, for no real type-safety
// benefit at this call surface.
interface AgentPublicClient {
  getTransactionCount(args: { address: `0x${string}`; blockTag: "pending" }): Promise<number>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ blockNumber: bigint }>;
}

interface AgentWalletClient {
  sendTransaction(args: {
    account: ReturnType<typeof privateKeyToAccount>;
    chain: typeof celo;
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    nonce: number;
  }): Promise<`0x${string}`>;
}

interface AgentWallet {
  account: ReturnType<typeof privateKeyToAccount>;
  address: `0x${string}`;
  walletClient: AgentWalletClient;
  publicClient: AgentPublicClient;
}

let _wallet: AgentWallet | null = null;

export function getAgentWallet(): AgentWallet {
  if (_wallet) return _wallet;

  const raw = env.gasStationPrivateKey;
  if (!raw || !raw.startsWith("0x")) {
    throw new Error("GAS_STATION_PRIVATE_KEY must be set (0x-prefixed hex private key)");
  }

  const account = privateKeyToAccount(raw as `0x${string}`);

  _wallet = {
    account,
    address: account.address,
    walletClient: createWalletClient({ account, chain: celo, transport: http(env.celoRpcUrl) }),
    publicClient: createPublicClient({ chain: celo, transport: http(env.celoRpcUrl) }),
  };
  return _wallet;
}

// In-process nonce counter — prevents "replacement transaction underpriced"
// when sending sequential txs (e.g. a sweep and a payout landing close
// together) without waiting for each to confirm first.
let _nonce: number | null = null;
const _nonceLock = { busy: false };

async function getNextNonce(publicClient: AgentPublicClient, address: `0x${string}`): Promise<number> {
  if (_nonce === null) {
    _nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
  }
  const n = _nonce;
  _nonce += 1;
  return n;
}

// Call after a tx error so the next send re-syncs its nonce from chain.
export function resetAgentNonce(): void {
  _nonce = null;
}

// Sends a transaction from the agent wallet. Serializes concurrent callers
// through a spin-lock so nonces are assigned sequentially, and retries once
// with a freshly re-synced nonce if the RPC rejects with a nonce error.
export async function agentSendTx(to: `0x${string}`, data: `0x${string}`, value = 0n): Promise<`0x${string}`> {
  while (_nonceLock.busy) {
    await new Promise((r) => setTimeout(r, 50));
  }
  _nonceLock.busy = true;

  try {
    const { walletClient, account, publicClient } = getAgentWallet();
    const nonce = await getNextNonce(publicClient, account.address);

    try {
      return await walletClient.sendTransaction({ account, chain: celo, to, data, value, nonce });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNonceError =
        msg.includes("nonce") || msg.includes("replacement transaction") || msg.includes("already known");
      if (!isNonceError) throw err;

      resetAgentNonce();
      const freshNonce = await getNextNonce(publicClient, account.address);
      return await walletClient.sendTransaction({ account, chain: celo, to, data, value, nonce: freshNonce });
    }
  } finally {
    _nonceLock.busy = false;
  }
}

export async function waitForAgentTx(hash: `0x${string}`): Promise<void> {
  const { publicClient } = getAgentWallet();
  await publicClient.waitForTransactionReceipt({ hash });
}
