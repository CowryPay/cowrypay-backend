import { createClient, getQuote, getStepTransaction, getStatus } from "@lifi/sdk";
import type { SDKClient, LiFiStep } from "@lifi/sdk";
import { encodeFunctionData, parseUnits } from "viem";
import { createSolanaRpc, getTransactionDecoder, sendTransactionWithoutConfirmingFactory } from "@solana/kit";
import { signTransactionWithSigners, getSignatureFromTransaction } from "@solana/kit";
import { env } from "../../../config/env.js";
import { getChainConfig, getTokenConfig } from "../../wallets/chains.js";
import { getWalletAddress } from "../../wallets/awsKmsAdapter.js";
import { getSolanaMint, SOLANA_TOKEN_DECIMALS } from "../../wallets/solanaAdapter.js";
import { getSolanaTreasurySigner } from "../../wallets/solanaKms.js";
import { sendRawEvmTx } from "./evmRawTx.js";
import type { BridgeAdapter, BridgeInitiateInput, BridgeInitiateResult, BridgePhaseCheckResult, BridgeQuote } from "./adapter.js";

// Celo has no native CCTP support at all — confirmed against both
// Circle's official docs AND Circle's own SDK internals (its Celo chain
// definition exists but cctp is explicitly null, 2026-08-19). This
// adapter routes any Celo-touching leg through LI.FI instead, an
// aggregator that composes whichever underlying bridge + DEX swap gets
// the recipient the REAL requested token — unlike Wormhole's own transfer
// mechanisms (Wrapped Token Transfer, Native Token Transfers), which both
// mint a new, non-canonical token contract on the destination that this
// codebase's ledger/balance code wouldn't recognize. Confirmed live
// (li.quest/v1/tokens) that LI.FI's own token registry already has the
// exact canonical USDC addresses this codebase uses on Base and Celo.
//
// This is a materially different trust model than the native-CCTP legs
// (Base/Optimism/Solana): a real third party (whichever bridge LI.FI
// selects) and a swap step are both involved, so unlike CCTP's clean 1:1
// burn-mint, the amount actually delivered can be slightly less than
// netAmount (slippage) — accepted, deliberate trade-off for Celo
// specifically, not something to "fix" by pretending it's 1:1.
//
// Also handles Celo<->Solana, since LI.FI is chain-agnostic: confirmed
// live (li.quest/v1/chains) Solana's LI.FI chain ID is 1151111081099710.
// Solana's signing path is genuinely different from EVM's — see
// initiateSolanaSourceLeg below.
const LIFI_CHAIN_IDS: Record<string, number> = { celo: 42220, base: 8453, optimism: 10, solana: 1151111081099710 };

// Which of the chains LI.FI knows about (LIFI_CHAIN_IDS) are actually
// offered right now — kept separate from LIFI_CHAIN_IDS itself (which
// stays complete, including optimism, so the rpcUrls map and
// requireLiFiChainId below don't need touching) mirroring cctpAdapter.ts's
// own SUPPORTED_CHAINS/getChainDefinition split. Optimism is withheld:
// deposits on Optimism are on hold (DEPOSIT_CHAINS in
// ai-agent/chat/intent.ts), so there's no way for a user to hold an
// Optimism balance to send from yet. Re-enable by adding it back here
// once Optimism deposits ship.
const SUPPORTED_CHAINS = new Set(["celo", "base", "solana"]);

// Conservative defaults — not yet tuned against real transfers. slippage
// is fractional (0.005 = 0.5%); maxPriceImpact hides routes worse than
// this rather than silently accepting a bad quote.
const SLIPPAGE = 0.005;
const MAX_PRICE_IMPACT = 0.02;

let cachedClient: SDKClient | null = null;
function getLiFiClient(): SDKClient {
  if (cachedClient) return cachedClient;
  cachedClient = createClient({
    integrator: "cowrypay",
    apiUrl: "https://li.quest/v1",
    debug: false,
    // Feeds LI.FI our own already-verified RPC URLs (chains.ts /
    // env.solanaRpcUrl) for whichever chains it needs to read from,
    // rather than whatever public default it would otherwise pick.
    rpcUrls: {
      [LIFI_CHAIN_IDS.base]: [getChainConfig("base").rpcUrl],
      [LIFI_CHAIN_IDS.optimism]: [getChainConfig("optimism").rpcUrl],
      [LIFI_CHAIN_IDS.celo]: [getChainConfig("celo").rpcUrl],
      [LIFI_CHAIN_IDS.solana]: [env.solanaRpcUrl],
    },
  });
  return cachedClient;
}

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function requireLiFiChainId(chain: string): number {
  const chainId = LIFI_CHAIN_IDS[chain.toLowerCase()];
  if (!chainId) throw new Error(`${chain} has no LI.FI chain ID registered`);
  return chainId;
}

// Token address, decimals, and "who signs on this platform's behalf on
// this chain" all differ between EVM chains (chains.ts's registry, the
// KMS payout wallet) and Solana (its own mint registry in
// solanaAdapter.ts, the Solana treasury signer) — mirrors
// cctpBridge.ts's own EVM-vs-Solana branching (that file predates this
// one and has its own small, independent copy of the same split; not
// unified into one shared module to avoid touching already-verified code
// for this addition).
async function tokenAddressFor(chain: string, tokenSymbol: string): Promise<{ address: string; decimals: number }> {
  if (chain.toLowerCase() === "solana") {
    return { address: getSolanaMint(tokenSymbol), decimals: SOLANA_TOKEN_DECIMALS };
  }
  return getTokenConfig(chain, tokenSymbol);
}

async function signerAddressFor(chain: string): Promise<string> {
  if (chain.toLowerCase() === "solana") {
    const signer = await getSolanaTreasurySigner();
    return signer.address;
  }
  if (!env.awsKmsPayoutKeyArn) throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set to bridge via LI.FI");
  return getWalletAddress(env.awsKmsPayoutKeyArn);
}

async function requestQuote(input: {
  sourceChain: string;
  destinationChain: string;
  tokenSymbol: string;
  amount: string;
  destinationAddress: string;
}): Promise<LiFiStep> {
  const [{ address: fromTokenAddress, decimals }, { address: toTokenAddress }, fromAddress] = await Promise.all([
    tokenAddressFor(input.sourceChain, input.tokenSymbol),
    tokenAddressFor(input.destinationChain, input.tokenSymbol),
    signerAddressFor(input.sourceChain),
  ]);

  return getQuote(getLiFiClient(), {
    fromChain: requireLiFiChainId(input.sourceChain),
    toChain: requireLiFiChainId(input.destinationChain),
    fromToken: fromTokenAddress,
    toToken: toTokenAddress,
    fromAmount: parseUnits(input.amount, decimals).toString(),
    fromAddress,
    toAddress: input.destinationAddress,
    slippage: SLIPPAGE,
    maxPriceImpact: MAX_PRICE_IMPACT,
  });
}

// Solana's leg of a LI.FI route arrives as a single, fully pre-compiled
// transaction (confirmed live against the real API, 2026-08-19:
// transactionRequest.data is a base64 blob, not {to, data, value} the way
// every EVM step is) — unlike EVM, where our own approve() call precedes
// a separate step transaction, Solana transactions can bundle multiple
// instructions (including any delegate/approval) into one atomic
// transaction, so there's nothing separate to approve here; this is the
// only signing step for a Solana source leg.
//
// Deliberately broadcasts WITHOUT waiting for confirmation (unlike
// solanaAdapter.ts's own signAndSendTransaction, which blocks synchronously
// for up to ~90s — a pattern that fits wallet creation but not this
// feature's broadcast-then-poll architecture). checkStatus below already
// gets source-confirmation status from LI.FI's own getStatus, chain-
// agnostically, so there's no need to independently poll Solana's RPC too.
async function initiateSolanaSourceLeg(step: LiFiStep): Promise<string> {
  if (!step.transactionRequest?.data) {
    throw new Error("LI.FI did not return a transaction to sign for this Solana route");
  }
  const transactionBytes = Buffer.from(step.transactionRequest.data, "base64");
  const transaction = getTransactionDecoder().decode(transactionBytes);

  const signer = await getSolanaTreasurySigner();
  const signedTransaction = await signTransactionWithSigners([signer], transaction);
  const signature = getSignatureFromTransaction(signedTransaction);

  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const sendWithoutConfirming = sendTransactionWithoutConfirmingFactory({ rpc });
  await sendWithoutConfirming(signedTransaction as never, { commitment: "confirmed" });
  return signature;
}

export const liFiAdapter: BridgeAdapter = {
  supports(sourceChain: string, destinationChain: string): boolean {
    return SUPPORTED_CHAINS.has(sourceChain.toLowerCase()) && SUPPORTED_CHAINS.has(destinationChain.toLowerCase());
  },

  async quote(input): Promise<BridgeQuote> {
    // A pure quote (no real send happening yet) has no real recipient to
    // give LI.FI — the platform's own signer address on the destination
    // chain is a safe placeholder; quotes are priced off amount/route,
    // not the specific recipient.
    const placeholderAddress = await signerAddressFor(input.destinationChain);
    const step = await requestQuote({ ...input, destinationAddress: placeholderAddress });
    // toAmountMin, not the optimistic toAmount — the guaranteed floor is
    // the honest number to report, given a swap step is involved.
    const { decimals } = await tokenAddressFor(input.destinationChain, input.tokenSymbol);
    const destinationAmount = (Number(step.estimate.toAmountMin) / 10 ** decimals).toString();
    return { estimatedSeconds: step.estimate.executionDuration, destinationAmount };
  },

  async initiate(input: BridgeInitiateInput): Promise<BridgeInitiateResult> {
    const step = await requestQuote(input);

    let sourceTxHash: string;
    if (input.sourceChain.toLowerCase() === "solana") {
      sourceTxHash = await initiateSolanaSourceLeg(step);
    } else {
      const { address: fromTokenAddress } = await tokenAddressFor(input.sourceChain, input.tokenSymbol);
      // Approve LI.FI's selected route to spend the source token, unless
      // this specific route doesn't need it (estimate.skipApproval) —
      // same "approve before the real step" shape as cctpBridge.ts's
      // depositForBurn.
      if (!step.estimate.skipApproval) {
        const approveData = encodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [step.estimate.approvalAddress as `0x${string}`, BigInt(step.action.fromAmount)],
        });
        await sendRawEvmTx(input.sourceChain, fromTokenAddress as `0x${string}`, approveData);
      }

      // getQuote's step doesn't always carry live calldata —
      // getStepTransaction fetches the actual, current transactionRequest
      // to sign, same "quote now, fresh tx data at broadcast time"
      // separation as most aggregators use since prices/calldata can
      // shift between the two calls.
      const stepWithTx = await getStepTransaction(getLiFiClient(), step);
      if (!stepWithTx.transactionRequest?.to || !stepWithTx.transactionRequest.data) {
        throw new Error("LI.FI did not return a transaction to sign for this route");
      }
      const { to, data, value } = stepWithTx.transactionRequest;
      sourceTxHash = await sendRawEvmTx(input.sourceChain, to as `0x${string}`, data as `0x${string}`, value ? BigInt(value) : 0n);
    }

    return {
      sourceTxHash,
      bridgeReference: {
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain,
        sourceTxHash,
        tool: step.tool,
      },
    };
  },

  async checkStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult> {
    const ref = bridgeReference as unknown as {
      sourceChain: string;
      destinationChain: string;
      sourceTxHash: string;
      tool: string;
    };

    const result = await getStatus(getLiFiClient(), {
      txHash: ref.sourceTxHash,
      bridge: ref.tool,
      fromChain: requireLiFiChainId(ref.sourceChain),
      toChain: requireLiFiChainId(ref.destinationChain),
    });

    if (result.status === "FAILED") {
      return { phase: "FAILED", detail: result.substatus ?? "lifi_failed" };
    }

    if (result.status === "DONE") {
      // PARTIAL means something didn't complete as quoted (e.g. a
      // fallback path returned a different/lesser amount) — deliberately
      // NOT treated as a clean success. By the time this is reported the
      // source leg is already irreversible, so this becomes STUCK via
      // the poller's existing safety split, not silently marked complete.
      if (result.substatus === "PARTIAL") {
        return { phase: "FAILED", detail: "lifi_partial_completion_needs_review" };
      }
      const destinationTxHash = "txHash" in result.receiving ? result.receiving.txHash : undefined;
      return { phase: "DESTINATION_CONFIRMED", destinationTxHash };
    }

    // PENDING, NOT_FOUND, or INVALID (the latter two most likely mean
    // LI.FI's indexer hasn't picked up the just-broadcast tx yet) — all
    // read as "still working on it, check again next tick."
    if (result.status === "PENDING" && result.substatus === "WAIT_SOURCE_CONFIRMATIONS") {
      return { phase: "SOURCE_PENDING" };
    }
    return { phase: "ATTESTATION_PENDING" };
  },
};
