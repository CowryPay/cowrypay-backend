import { createWalletClient, http, BaseError, HttpRequestError } from "viem";
import { env } from "../../../config/env.js";
import { getChainConfig } from "../../wallets/chains.js";
import { getWalletAddress, kmsAccountFromKey } from "../../wallets/awsKmsAdapter.js";
import { fetchPendingNonce, withClaimedNonce } from "../../wallets/evmNonce.js";

const TRANSPORT_RETRY_ATTEMPTS = 3;
const TRANSPORT_RETRY_DELAY_MS = 750;

// Real incident (2026-10-18): a user's cross-chain send failed outright on
// a 429 from our Alchemy Celo endpoint while broadcasting the CCTP
// approve() transaction — a transient rate-limit blip, not a real failure
// (the exact same mechanics as the Solana equivalent in solanaAdapter.ts's
// withTransportRetry, which that file's own comment covers in more
// detail). Neither this function nor cctpBridge.ts's executePrepared
// (which imports this) had any retry on the actual broadcast call before
// this — one transient blip aborted the whole send. Scoped specifically to
// viem's HttpRequestError on a 429/5xx status so a REAL failure (reverted
// simulation, insufficient funds, nonce conflict, etc.) still fails
// immediately instead of being masked behind pointless retrying.
export async function withEvmTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transportError =
        err instanceof BaseError
          ? err.walk((e) => e instanceof HttpRequestError && (e.status === 429 || (e.status ?? 0) >= 500))
          : null;
      if (attempt >= TRANSPORT_RETRY_ATTEMPTS || !transportError) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS * attempt));
    }
  }
}

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

  return withClaimedNonce(chain, fetchFreshNonce, (nonce) =>
    withEvmTransportRetry(() => walletClient.sendTransaction({ to, data, value, nonce })),
  );
}
