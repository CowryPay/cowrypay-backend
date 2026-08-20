import { createWalletClient, http } from "viem";
import { env } from "../../../config/env.js";
import { getChainConfig } from "../../wallets/chains.js";
import { getWalletAddress, kmsAccountFromKey } from "../../wallets/awsKmsAdapter.js";
import { claimNonce, resyncNonce, isNonceError, fetchPendingNonce } from "../../wallets/evmNonce.js";

// Shared "sign and broadcast a raw {to, data, value} transaction from the
// KMS payout wallet, coordinated through the one shared in-process nonce
// sequence (evmNonce.ts)" primitive — used by liFiAdapter.ts for LI.FI's
// own transactionRequest objects. cctpBridge.ts has its own inline
// version of this same pattern (predates this file); both ultimately go
// through claimNonce/resyncNonce, so every EVM signer of this wallet
// still stays coordinated regardless of which bridge is doing the
// signing — see evmNonce.ts's own comment on why that coordination
// matters (a real production incident on this exact shared wallet).
export async function sendRawEvmTx(chain: string, to: `0x${string}`, data: `0x${string}`, value: bigint = 0n): Promise<string> {
  if (!env.awsKmsPayoutKeyArn) throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set to bridge from an EVM chain");
  const { viemChain, rpcUrl } = getChainConfig(chain);
  const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
  const account = kmsAccountFromKey(env.awsKmsPayoutKeyArn, payoutAddress);
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
  const fetchFreshNonce = fetchPendingNonce(viemChain, rpcUrl, payoutAddress);

  async function attempt(): Promise<string> {
    const nonce = await claimNonce(chain, fetchFreshNonce);
    return walletClient.sendTransaction({ to, data, value, nonce });
  }

  try {
    return await attempt();
  } catch (err) {
    if (!isNonceError(err)) throw err;
    resyncNonce(chain);
    return await attempt();
  }
}
