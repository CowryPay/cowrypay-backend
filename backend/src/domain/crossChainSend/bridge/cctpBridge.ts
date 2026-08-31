import { createPublicClient, createWalletClient, http, parseUnits, type Chain } from "viem";
import { createSolanaRpc } from "@solana/kit";
import { ViemAdapter } from "@circle-fin/adapter-viem-v2";
import { SolanaKitAdapter } from "@circle-fin/adapter-solana-kit";
import { CCTPV2BridgingProvider } from "@circle-fin/provider-cctp-v2";
import type { ChainDefinition } from "@circle-fin/bridge-kit";
import { env } from "../../../config/env.js";
import { getChainConfig } from "../../wallets/chains.js";
import { getWalletAddress, kmsAccountFromKey } from "../../wallets/awsKmsAdapter.js";
import { claimNonce, resyncNonce, isNonceError, fetchPendingNonce } from "../../wallets/evmNonce.js";
import { getSolanaTreasurySigner } from "../../wallets/solanaKms.js";
import { CHAIN_DEFINITIONS, getChainDefinition } from "./chainDefinitions.js";
import type { BridgeInitiateInput, BridgeInitiateResult, BridgePhaseCheckResult } from "./adapter.js";

// Built on Circle's own official CCTP v2 SDK (provider-cctp-v2 +
// adapter-viem-v2 + adapter-solana-kit) rather than hand-encoded ABI/
// program calls — Circle maintains the contract addresses/ABI/PDA
// derivation, not us (see chainDefinitions.ts). Chain-agnostic despite
// the filename's history: originally EVM-only, generalized once Solana
// support was added — the CCTP burn/attestation/mint orchestration below
// is identical regardless of which chain type is on either side.
//
// Deliberately does NOT call the SDK's all-in-one provider.bridge()/
// kit.bridge() — that call internally polls Circle's attestation API with
// a default of up to 600 retries at a 2s interval (confirmed by reading
// the compiled SDK source, 2026-08-19) — i.e. it can block for up to ~20
// minutes. That's unsafe inside an HTTP request handler and doesn't fit
// this codebase's broadcast-now-confirm-later architecture (see every
// other withdraw()/poller pair in this codebase). Instead this uses the
// SDK's lower-level composable steps (approve/burn/fetchAttestation/mint/
// waitForTransaction) directly, with OUR OWN poller
// (crossChainSendConfirmationPoller.ts) driving a short, bounded check on
// each tick — same overall shape as every other multi-step confirmation
// flow here, just using Circle's verified step implementations instead
// of hand-rolled ones.

export const EVM_CHAINS_HERE = new Set(["base", "optimism"]);

// Real incident: an SDK update started enforcing at runtime what the type
// (readonly ChainDefinition[]) always implied but never checked —
// "Invalid AdapterCapabilities: supportedChains cannot be empty." The []
// below was deliberate at the time (see each adapter's own comment on
// why cctpAdapter.ts's own pairs logic, not this file, should scope
// what's offered) but the SDK no longer accepts an empty array at all,
// regardless of who's meant to own the scoping decision. Populated from
// chainDefinitions.ts's own registry — the single source of truth this
// file already depends on elsewhere — split by adapter kind (EVM vs
// Solana), not the full registry for both, since an adapter declaring a
// chain it can't actually sign for would be a lie the SDK might act on.
const EVM_CHAIN_DEFINITIONS = [CHAIN_DEFINITIONS.base, CHAIN_DEFINITIONS.optimism].filter(
  (def): def is NonNullable<typeof def> => def != null,
);
const SOLANA_CHAIN_DEFINITIONS = [CHAIN_DEFINITIONS.solana].filter((def): def is NonNullable<typeof def> => def != null);

// ViemAdapter's getPublicClient/getWalletClient callbacks hand back a
// genuine viem Chain (not Circle's own ChainDefinition — confirmed by
// what actually type-checks here), matching the README's own example of
// passing it straight into createPublicClient. Mapped back to our own
// chain registry key (wallets/chains.ts) by name so the RPC URL used is
// the SAME already-verified one used everywhere else in this codebase,
// not whatever default viem's Chain object carries.
function ourChainNameFor(viemChain: Chain): string {
  const name = viemChain.name.toLowerCase();
  if (getChainDefinition(name)) return name;
  throw new Error(`Unrecognized chain: ${viemChain.name}`);
}

let cachedViemAdapter: ViemAdapter | null = null;
async function getViemAdapter(): Promise<ViemAdapter> {
  if (cachedViemAdapter) return cachedViemAdapter;
  if (!env.awsKmsPayoutKeyArn) {
    throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set to bridge via CCTP");
  }
  const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
  const account = kmsAccountFromKey(env.awsKmsPayoutKeyArn, payoutAddress);

  cachedViemAdapter = new ViemAdapter(
    {
      getPublicClient: ({ chain }) => {
        const { viemChain, rpcUrl } = getChainConfig(ourChainNameFor(chain));
        return createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
      },
      getWalletClient: ({ chain }) => {
        const { viemChain, rpcUrl } = getChainConfig(ourChainNameFor(chain));
        return createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
      },
    },
    // Real incident: "developer-controlled" was wrong from the start —
    // read the compiled SDK source (index.mjs's resolveEffectiveAccount)
    // and confirmed it forces every send through a {type: 'json-rpc'}
    // account, meaning the SDK asks the TRANSPORT itself to sign via
    // eth_sendTransaction — a mode built for remote custody APIs
    // (Fireblocks, Circle Wallets) that intercept that RPC method and
    // sign server-side. A plain RPC provider (Alchemy) has no such
    // capability and correctly rejects it outright. Our own account is a
    // real local viem Account (kmsAccountFromKey, KMS-backed but signs
    // locally via signTransaction) going through a standard RPC — exactly
    // what the SDK's own validation message calls out as needing
    // "user-controlled" ("browser wallets, private keys, or hardware
    // wallets"). Safe to switch: our own walletContexts() already passes
    // an explicit address on every WalletContext, so this mode's
    // getAddress-resolution fallback is never actually needed.
    { addressContext: "user-controlled", supportedChains: EVM_CHAIN_DEFINITIONS },
  );
  return cachedViemAdapter;
}

// The Solana leg signs with the same treasury signer solanaAdapter.ts
// already uses to fund/pay for on-chain Solana operations (mirrors the
// EVM payout wallet's role exactly: one shared operational key, not
// per-user). Uses the same getRpc/getSigner factory pattern as
// ViemAdapter above (confirmed against the actual compiled type
// definitions — the README's simpler {rpc, signer} manual-setup example
// doesn't match SolanaKitAdapterOptions as currently published).
// getSigner ignores its OperationContext param and always returns the
// same treasury TransactionSigner, exactly like getWalletClient above
// ignores anything beyond resolving our own account.
let cachedSolanaAdapter: SolanaKitAdapter | null = null;
async function getSolanaAdapter(): Promise<SolanaKitAdapter> {
  if (cachedSolanaAdapter) return cachedSolanaAdapter;
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  cachedSolanaAdapter = new SolanaKitAdapter(
    {
      getRpc: () => rpc,
      getSigner: () => getSolanaTreasurySigner(),
    },
    // Same correction as getViemAdapter's own — "user-controlled" is the
    // right mode for a real local signer (getSolanaTreasurySigner), not
    // a remote custody API. Solana doesn't have an eth_sendTransaction-
    // style failure mode (its signer always signs locally regardless),
    // but the address-resolution behavior still matches what
    // "developer-controlled" was never really meant for here.
    { addressContext: "user-controlled", supportedChains: SOLANA_CHAIN_DEFINITIONS },
  );
  return cachedSolanaAdapter;
}

export type ChainAdapter = ViemAdapter | SolanaKitAdapter;

// Exported for stellarCctpAdapter.ts's reuse — a Base/Optimism/Solana leg
// of a Stellar-touching pair still signs/broadcasts through the exact
// same adapters and nonce coordination as every other CCTP pair; only the
// mintRecipient/hookData construction differs for a Stellar destination
// (see that file's own comment on why), not the underlying signing
// machinery. Pure export additions below (getAdapterForChain,
// getSignerAddressForChain, withSharedNonce, executePrepared) — no
// behavior changes to this file.
export async function getAdapterForChain(chain: string): Promise<ChainAdapter> {
  return EVM_CHAINS_HERE.has(chain.toLowerCase()) ? getViemAdapter() : getSolanaAdapter();
}

export async function getSignerAddressForChain(chain: string): Promise<string> {
  if (EVM_CHAINS_HERE.has(chain.toLowerCase())) {
    if (!env.awsKmsPayoutKeyArn) throw new Error("AWS_KMS_PAYOUT_KEY_ARN must be set to bridge via CCTP");
    return getWalletAddress(env.awsKmsPayoutKeyArn);
  }
  const signer = await getSolanaTreasurySigner();
  return signer.address;
}

const provider = new CCTPV2BridgingProvider();

// Same claim/resync-on-mismatch nonce pattern as awsKmsAdapter.ts's
// withdraw() and evmNonce.ts's own doc comment on why this exists (a
// real production incident: independent per-call "pending nonce" RPC
// queries on this same shared KMS payout wallet went stale after the
// Alchemy switch). The SDK's own PreparedChainRequest.execute() would
// otherwise ask the RPC for a nonce independently per call — routing it
// through claimNonce keeps every signer of this wallet (same-chain
// withdrawals, deposit-sweep gas top-ups, and this bridge's EVM legs)
// coordinated through the one shared in-process sequence. Solana has no
// equivalent concept (transactions use a recent blockhash, handled
// internally by the adapter) — only used for EVM legs, see executePrepared.
export async function withSharedNonce<T>(chain: string, run: (nonce: number) => Promise<T>): Promise<T> {
  const { viemChain, rpcUrl } = getChainConfig(chain);
  const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn!);
  const fetchFreshNonce = fetchPendingNonce(viemChain, rpcUrl, payoutAddress);

  try {
    return await run(await claimNonce(chain, fetchFreshNonce));
  } catch (err) {
    if (!isNonceError(err)) throw err;
    resyncNonce(chain);
    return await run(await claimNonce(chain, fetchFreshNonce));
  }
}

// The provider's WalletContext.chain type requires ChainDefinitionWithCCTPv2
// — a ChainDefinition narrowed so `cctp` AND `cctp.contracts.v2` are both
// guaranteed present. That exact type isn't part of either package's
// public export surface, so it can't be named/reconstructed precisely
// with TS utility types (attempted a shallow NonNullable<cctp> narrowing
// first; TS still rejected it over the nested optional contracts.v2).
// Runtime-checked here instead — every chain this file ever registers in
// chainDefinitions.ts genuinely has CCTP v2 configured, by construction —
// and cast past the unnamed-type gap at this one contained boundary
// rather than widening any function's real parameter types to `any`.
function requireCctpChain(def: ChainDefinition, chainName: string): ChainDefinition {
  if (!def.cctp?.contracts?.v2) {
    throw new Error(`${chainName}'s ChainDefinition has no CCTP v2 configuration`);
  }
  return def;
}

async function walletContexts(sourceChain: string, destinationChain: string, destinationAddress: string) {
  const sourceChainDef = getChainDefinition(sourceChain);
  const destChainDef = getChainDefinition(destinationChain);
  if (!sourceChainDef || !destChainDef) {
    throw new Error(`${sourceChain} or ${destinationChain} has no CCTP chain definition registered`);
  }
  const [sourceAdapter, destinationAdapter, sourceAddress, destinationSignerAddress] = await Promise.all([
    getAdapterForChain(sourceChain),
    getAdapterForChain(destinationChain),
    getSignerAddressForChain(sourceChain),
    getSignerAddressForChain(destinationChain),
  ]);
  // Cast past ChainDefinitionWithCCTPv2's unexported-type gap (see
  // requireCctpChain's own comment) — the runtime check above is what
  // actually guarantees safety here, not this cast.
  const source = { adapter: sourceAdapter, address: sourceAddress, chain: requireCctpChain(sourceChainDef, sourceChain) };
  const destination = {
    adapter: destinationAdapter,
    address: destinationSignerAddress,
    chain: requireCctpChain(destChainDef, destinationChain),
    recipientAddress: destinationAddress,
  };
  return { source, destination } as unknown as {
    source: Parameters<typeof provider.approve>[0];
    destination: Parameters<typeof provider.burn>[0]["destination"];
  };
}

// PreparedChainRequest (this file's inferred type for what approve/burn/
// mint return, without needing to import its unexported name) is a union
// of Evm | Solana | Noop variants with incompatible execute() signatures.
// Dispatches by the `.type` discriminant: EVM legs go through the shared
// nonce sequence above; Solana legs have no nonce concept, so execute()
// is called directly; Noop means this step doesn't apply on this chain
// (e.g. Solana has no ERC-20-style approve step) — nothing to broadcast,
// returns null rather than a placeholder hash.
export type Prepared = Awaited<ReturnType<typeof provider.approve>>;
export async function executePrepared(chain: string, prepared: Prepared): Promise<string | null> {
  if (prepared.type === "noop") return null;
  if (prepared.type === "evm") {
    return withSharedNonce(chain, (nonce) =>
      (prepared as unknown as { execute(overrides?: { nonce?: number }): Promise<string> }).execute({ nonce }),
    );
  }
  if (prepared.type === "solana") {
    return (prepared as unknown as { execute(): Promise<string> }).execute();
  }
  throw new Error(`Unexpected prepared request type: "${(prepared as { type: string }).type}"`);
}

// Broadcasts approve (if applicable on the source chain) + depositForBurn
// as sequential transactions. Does NOT wait for either to be mined or for
// the bridge to complete — mirrors WalletAdapter.withdraw's broadcast-
// and-return-immediately stance; checkCctpStatus below is what tracks
// confirmation, phase by phase, on the poller's own schedule.
// CCTP only ever moves USDC (token: "USDC" below, hardcoded), 6 decimals
// on every chain this codebase touches — same constant every other USDC
// amount conversion here already assumes (solanaAdapter.ts's
// SOLANA_TOKEN_DECIMALS, chains.ts's per-chain token configs).
const CCTP_USDC_DECIMALS = 6;

export async function initiateCctpBurn(input: BridgeInitiateInput): Promise<BridgeInitiateResult> {
  const { source, destination } = await walletContexts(input.sourceChain, input.destinationChain, input.destinationAddress);

  // Real incident: input.amount is a human decimal string (e.g. "1.98") —
  // the SDK's own docs show amount as a base-units integer string
  // ("amount: '1000000', // 1 USDC"), and its internal BigInt(amount)
  // call throws "Cannot convert 1.98 to a BigInt" on anything with a
  // decimal point. liFiAdapter.ts already does this same parseUnits
  // conversion for its own on-chain calls; this file never did.
  const amountBaseUnits = parseUnits(input.amount, CCTP_USDC_DECIMALS).toString();

  const approvePrepared = await provider.approve(source, amountBaseUnits);
  await executePrepared(input.sourceChain, approvePrepared);

  const burnPrepared = await provider.burn({
    source,
    destination,
    amount: amountBaseUnits,
    token: "USDC",
    // FAST, not the original conservative SLOW (hard-finality) choice —
    // verified live against Circle's real fee docs: Base's Fast Transfer
    // fee is 1.3bps (0.013%, ~$0.13 per $1,000), deducted from the minted
    // amount at destination, for 8-20s finality instead of SLOW's ~15-20
    // minute wait. Explicit product decision (2026-08-27) to trade that
    // negligible fee for a ~50-100x speedup.
    config: { transferSpeed: "FAST" },
  });
  const burnTxHash = await executePrepared(input.sourceChain, burnPrepared);
  if (!burnTxHash) throw new Error(`depositForBurn returned no transaction hash for ${input.sourceChain}`);

  return {
    sourceTxHash: burnTxHash,
    bridgeReference: {
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      destinationAddress: input.destinationAddress,
      burnTxHash,
    },
  };
}

interface CctpBridgeReference {
  sourceChain: string;
  destinationChain: string;
  destinationAddress: string;
  burnTxHash: string;
  destinationTxHash?: string;
}

// Chain-agnostic confirmation check via the SDK's own waitForTransaction —
// replaces this file's earlier EVM-only getReceiptStatus (wallets/
// receiptStatus.ts) now that a leg can be Solana. Bounded to a short
// per-tick timeout (not indefinite) so an unconfirmed tx reads as "still
// pending" rather than blocking the poller.
export async function checkTxConfirmed(chain: string, txHash: string): Promise<"pending" | "success" | "reverted"> {
  const chainDef = getChainDefinition(chain);
  if (!chainDef) throw new Error(`${chain} has no CCTP chain definition registered`);
  const adapter = await getAdapterForChain(chain);
  try {
    const result = await provider.waitForTransaction(adapter, txHash, chainDef, { timeout: 5_000 });
    return result.status;
  } catch {
    return "pending";
  }
}

// Single idempotent "check current state, advance one step if possible"
// function, called repeatedly by crossChainSendConfirmationPoller.ts.
export async function checkCctpStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult> {
  const ref = bridgeReference as unknown as CctpBridgeReference;

  if (!ref.destinationTxHash) {
    const burnStatus = await checkTxConfirmed(ref.sourceChain, ref.burnTxHash);
    if (burnStatus === "pending") return { phase: "SOURCE_PENDING" };
    if (burnStatus === "reverted") return { phase: "FAILED", detail: "source_burn_reverted" };

    const { source, destination } = await walletContexts(ref.sourceChain, ref.destinationChain, ref.destinationAddress);

    // Deliberately a SINGLE short-budget check (maxRetries: 1), not the
    // SDK's default up-to-20-minute internal loop — see this file's top
    // comment. "Not ready" is the expected, common outcome of most ticks;
    // caught below and treated the same as a clean "still pending" signal.
    let attestation: Awaited<ReturnType<typeof provider.fetchAttestation>>;
    try {
      attestation = await provider.fetchAttestation(source, ref.burnTxHash, { maxRetries: 1, timeout: 5_000 });
    } catch {
      return { phase: "ATTESTATION_PENDING" };
    }
    if (attestation.status !== "complete") {
      return { phase: "ATTESTATION_PENDING" };
    }

    const mintPrepared = await provider.mint(source, destination, attestation);
    const mintTxHash = await executePrepared(ref.destinationChain, mintPrepared);
    if (!mintTxHash) throw new Error(`mint returned no transaction hash for ${ref.destinationChain}`);
    return { phase: "DESTINATION_PENDING", destinationTxHash: mintTxHash, detail: "destination_mint_broadcast" };
  }

  // Mint already broadcast on an earlier tick — check its own confirmation.
  // A revert here is the STUCK case (see the poller's own risk-handling
  // comment): the source burn already confirmed, real and final, so this
  // must never fall back to FAILED/auto-refund.
  const mintStatus = await checkTxConfirmed(ref.destinationChain, ref.destinationTxHash);
  if (mintStatus === "pending") return { phase: "DESTINATION_PENDING", destinationTxHash: ref.destinationTxHash };
  if (mintStatus === "reverted") {
    return { phase: "FAILED", destinationTxHash: ref.destinationTxHash, detail: "destination_mint_reverted" };
  }
  return { phase: "DESTINATION_CONFIRMED", destinationTxHash: ref.destinationTxHash };
}
