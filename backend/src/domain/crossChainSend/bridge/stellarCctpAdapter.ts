import { CCTPV2BridgingProvider } from "@circle-fin/provider-cctp-v2";
import { parseUnits, getAddress, hexToBytes } from "viem";
import { Address as StellarAddress } from "@stellar/stellar-sdk";
import { getAddressEncoder, getAddressDecoder, address as toSolanaAddress } from "@solana/kit";
import { getChainDefinition } from "./chainDefinitions.js";
import {
  getAdapterForChain,
  getSignerAddressForChain,
  executePrepared,
  checkTxConfirmed,
  type Prepared,
} from "./cctpBridge.js";
import {
  getStellarCctpContracts,
  getStellarChainDefinition,
  getStellarUsdcContractId,
  submitStellarContractCall,
  checkStellarTxStatus,
  addressToBytes32,
  buildStellarForwardHookData,
  nativeToScVal,
  STELLAR_USDC_DECIMALS,
} from "./stellarCctpSoroban.js";
import { getStellarSigningKeypair } from "../../wallets/stellarKms.js";
import { isValidAddressForChain } from "../../cryptoWithdrawals/addressValidation.js";
import type { BridgeAdapter, BridgeInitiateInput, BridgeInitiateResult, BridgePhaseCheckResult, BridgeQuote } from "./adapter.js";

// Same USDC-is-always-6-decimals assumption cctpBridge.ts's own
// CCTP_USDC_DECIMALS makes for the EVM/Solana side of a transfer — kept
// as a local copy rather than importing that unexported constant, since
// it's a protocol fact (not configuration) safe to state twice. Stellar's
// OWN side of the transfer uses 7 decimals — see stellarCctpSoroban.ts's
// STELLAR_USDC_DECIMALS, imported above and used by the Stellar-as-source
// (Step B) burn below.
const EVM_SOLANA_USDC_DECIMALS = 6;

// Step A: base/optimism/solana -> stellar (Stellar as destination).
const NON_STELLAR_SOURCE_CHAINS = new Set(["base", "optimism", "solana"]);

// Step B: stellar -> base/solana only (Stellar as source) — matches
// cctpAdapter.ts's own SUPPORTED_CHAINS for the plain-pair mint side this
// reuses. Not optimism (not in ALL_CROSS_CHAIN_SEND_CHAINS at all — deposits
// on hold) and not celo (no CCTP domain, routes through liFiAdapter
// regardless of what's declared here — see bridge/index.ts's dispatch).
const STELLAR_SOURCE_DESTINATION_CHAINS = new Set(["base", "solana"]);

const provider = new CCTPV2BridgingProvider();

interface StellarCctpBridgeReference {
  direction: "toStellar";
  sourceChain: string;
  destinationAddress: string; // the real Stellar recipient (a G... strkey)
  burnTxHash: string;
}

interface StellarSourceBridgeReference {
  direction: "fromStellar";
  destinationChain: string;
  destinationAddress: string; // the real Base/Solana recipient
  burnTxHash: string; // Stellar Soroban deposit_for_burn tx hash
}

// mintRecipient must be a real EVM/Solana address encoded to bytes32 — no
// SDK involved on the Stellar burn side (same situation as Step A's
// hookData, hand-rolled entirely by this codebase). Reused by both the
// encoder and its own round-trip self-check below.
function encodeDestinationRecipientBytes32(destinationChain: string, address: string): Buffer {
  if (destinationChain.toLowerCase() === "solana") {
    return addressToBytes32(new Uint8Array(getAddressEncoder().encode(toSolanaAddress(address))));
  }
  return addressToBytes32(hexToBytes(getAddress(address)));
}

// Step B's analogue of Step A's "compare against one hardcoded constant"
// pre-flight (see the plan doc's own "Risk handling" reasoning) — there's
// no fixed correct value to check here, mintRecipient is a different real
// address every call, so the check instead re-derives the address from the
// bytes32 about to be signed and hard-throws on any mismatch. Catches an
// encoding bug on every single send, not just once.
function assertRecipientEncodingRoundTrips(destinationChain: string, original: string, encoded: Buffer): void {
  if (destinationChain.toLowerCase() === "solana") {
    const decoded = getAddressDecoder().decode(new Uint8Array(encoded));
    if (decoded !== original) {
      throw new Error(
        `Solana recipient bytes32 round-trip mismatch: encoded "${original}" but decoded back to "${decoded}" — refusing to burn`,
      );
    }
    return;
  }
  const decodedHex = `0x${encoded.subarray(12).toString("hex")}`;
  if (getAddress(decodedHex) !== getAddress(original)) {
    throw new Error(
      `EVM recipient bytes32 round-trip mismatch: encoded "${original}" but decoded back to "${decodedHex}" — refusing to burn`,
    );
  }
}

// Minimal WalletContext for the Stellar side of provider.fetchAttestation()/
// provider.mint() when Stellar is the SOURCE — traced in the compiled SDK
// source (see the plan doc) that neither call ever actually invokes
// source.adapter, only validates its shape structurally (zod: must have
// prepare/waitForTransaction as functions) and reads source.chain. Throws
// instead of no-op if a future SDK version DOES start calling it, so that
// change fails loudly instead of silently doing nothing.
async function buildStellarSourceWalletContext(): Promise<{
  adapter: { prepare: () => Promise<never>; waitForTransaction: () => Promise<never> };
  address: string;
  chain: ReturnType<typeof getStellarChainDefinition>;
}> {
  const keypair = await getStellarSigningKeypair();
  return {
    adapter: {
      prepare: () => {
        throw new Error("stellarSourceWalletContext.adapter.prepare should never be called — Stellar burns are hand-submitted");
      },
      waitForTransaction: () => {
        throw new Error(
          "stellarSourceWalletContext.adapter.waitForTransaction should never be called — Stellar tx status uses checkStellarTxStatus",
        );
      },
    },
    address: keypair.publicKey(),
    chain: getStellarChainDefinition(),
  };
}

async function initiateFromStellar(input: BridgeInitiateInput): Promise<BridgeInitiateResult> {
  const destinationChain = input.destinationChain.toLowerCase();
  if (!STELLAR_SOURCE_DESTINATION_CHAINS.has(destinationChain)) {
    throw new Error(`stellarCctpAdapter doesn't support stellar -> ${destinationChain} yet`);
  }
  const destinationChainDef = getChainDefinition(destinationChain);
  if (!destinationChainDef) throw new Error(`${destinationChain} has no CCTP chain definition registered`);
  const destinationDomain = destinationChainDef.cctp?.domain;
  if (destinationDomain == null) throw new Error(`${destinationChain} has no CCTP domain registered`);

  // Belt-and-suspenders — service.ts/crossChainSendDraft.ts already
  // validate this upstream, checked again here too, matching Step A's own
  // "don't trust upstream, check again at the point of danger" precedent.
  if (!isValidAddressForChain(destinationChain, input.destinationAddress)) {
    throw new Error(`"${input.destinationAddress}" doesn't look like a valid ${destinationChain} address — refusing to burn`);
  }
  const mintRecipientBytes32 = encodeDestinationRecipientBytes32(destinationChain, input.destinationAddress);
  assertRecipientEncodingRoundTrips(destinationChain, input.destinationAddress, mintRecipientBytes32);

  const contracts = getStellarCctpContracts();
  const amountBaseUnits = parseUnits(input.amount, STELLAR_USDC_DECIMALS).toString();

  // deposit_for_burn's exact Soroban parameter names/order are PREDICTED
  // by analogy to Circle's documented EVM CCTPv2 depositForBurn interface
  // (converted to Soroban/snake_case) — NOT live-verified against the
  // deployed contract's real spec, since this codebase had no outbound
  // network access to Stellar's RPC when this was written (see the plan
  // doc). Soroban's simulate-before-submit model inside
  // submitStellarContractCall's server.prepareTransaction call fails
  // cleanly here with no funds at risk if a param name/type is wrong —
  // MUST be verified against contract.Client.from()'s real on-chain spec
  // (same technique already used for mint_and_forward) before this ever
  // handles real funds.
  const submitted = await submitStellarContractCall(contracts.tokenMessengerMinter, "deposit_for_burn", [
    nativeToScVal(BigInt(amountBaseUnits), { type: "i128" }),
    nativeToScVal(destinationDomain, { type: "u32" }),
    nativeToScVal(mintRecipientBytes32, { type: "bytes" }),
    nativeToScVal(getStellarUsdcContractId(), { type: "address" }),
    nativeToScVal(Buffer.alloc(32), { type: "bytes" }), // destination_caller: zero = any caller, matches the SDK's own non-forwarder default (verified at index.mjs:11748)
    nativeToScVal(0n, { type: "i128" }), // max_fee
    nativeToScVal(1000, { type: "u32" }), // min_finality_threshold — FAST, matches every other leg's transfer-speed choice
  ]);

  const bridgeReference: StellarSourceBridgeReference = {
    direction: "fromStellar",
    destinationChain,
    destinationAddress: input.destinationAddress,
    burnTxHash: submitted.hash,
  };
  return { sourceTxHash: submitted.hash, bridgeReference: bridgeReference as unknown as Record<string, unknown> };
}

async function checkStatusFromStellar(
  ref: StellarSourceBridgeReference & { destinationTxHash?: string },
): Promise<BridgePhaseCheckResult> {
  if (!ref.destinationTxHash) {
    const burnStatus = await checkStellarTxStatus(ref.burnTxHash);
    if (burnStatus === "pending") return { phase: "SOURCE_PENDING" };
    if (burnStatus === "failed") return { phase: "FAILED", detail: "stellar_source_burn_failed" };

    const stellarSourceContext = await buildStellarSourceWalletContext();

    // Same bounded, single-attempt attestation check used everywhere else
    // in this codebase — "not ready" is the expected, common outcome of
    // most ticks, not an error.
    let attestation: Awaited<ReturnType<typeof provider.fetchAttestation>>;
    try {
      attestation = await provider.fetchAttestation(
        stellarSourceContext as unknown as Parameters<typeof provider.fetchAttestation>[0],
        ref.burnTxHash,
        { maxRetries: 1, timeout: 5_000 },
      );
    } catch {
      return { phase: "ATTESTATION_PENDING" };
    }
    if (attestation.status !== "complete") {
      return { phase: "ATTESTATION_PENDING" };
    }

    // The destination-side mint is the exact same provider.mint() +
    // executePrepared() call cctpBridge.ts's checkCctpStatus already makes
    // for a plain Base<->Solana pair — confirmed via source tracing (see
    // the plan doc) that provider.mint() never calls source.adapter at
    // all, only destination.adapter. Zero new destination-side mechanism.
    const destinationAdapter = await getAdapterForChain(ref.destinationChain);
    const destinationSignerAddress = await getSignerAddressForChain(ref.destinationChain);
    const destinationContext = {
      adapter: destinationAdapter,
      address: destinationSignerAddress,
      chain: getChainDefinition(ref.destinationChain),
      recipientAddress: ref.destinationAddress,
    };

    const mintPrepared = (await provider.mint(
      stellarSourceContext as unknown as Parameters<typeof provider.mint>[0],
      destinationContext as unknown as Parameters<typeof provider.mint>[1],
      attestation,
    )) as Prepared;
    const mintTxHash = await executePrepared(ref.destinationChain, mintPrepared);
    if (!mintTxHash) throw new Error(`receiveMessage returned no transaction hash for ${ref.destinationChain}`);
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

export const stellarCctpAdapter: BridgeAdapter = {
  supports(sourceChain: string, destinationChain: string): boolean {
    const source = sourceChain.toLowerCase();
    const destination = destinationChain.toLowerCase();
    if (NON_STELLAR_SOURCE_CHAINS.has(source) && destination === "stellar") return true;
    if (source === "stellar" && STELLAR_SOURCE_DESTINATION_CHAINS.has(destination)) return true;
    return false;
  },

  async quote(input): Promise<BridgeQuote> {
    // CCTP is always a clean 1:1 burn-mint, same as cctpAdapter.ts's own
    // quote() — no swap, no slippage. estimatedSeconds is a placeholder
    // (FAST-mode burn confirmation, plus this leg's extra
    // mint_and_forward submission step beyond the other CCTP pairs) —
    // worth measuring against real transfers once this ships.
    return { estimatedSeconds: 90, destinationAmount: input.amount };
  },

  async initiate(input: BridgeInitiateInput): Promise<BridgeInitiateResult> {
    if (!stellarCctpAdapter.supports(input.sourceChain, input.destinationChain)) {
      throw new Error(`stellarCctpAdapter doesn't support ${input.sourceChain} -> ${input.destinationChain} yet`);
    }
    if (input.sourceChain.toLowerCase() === "stellar") {
      return initiateFromStellar(input);
    }
    const sourceChain = input.sourceChain.toLowerCase();
    const sourceChainDef = getChainDefinition(sourceChain);
    if (!sourceChainDef) throw new Error(`${sourceChain} has no CCTP chain definition registered`);

    const contracts = getStellarCctpContracts();
    const forwarderBytes32 = addressToBytes32(StellarAddress.fromString(contracts.cctpForwarder).toBuffer());
    // Safety pre-flight — see the plan doc's "Risk handling" section.
    // mintRecipient/destinationCaller getting this wrong makes funds
    // permanently, unrecoverably stuck on Stellar (Circle's own explicit
    // warning, unlike every other STUCK case elsewhere in this codebase,
    // which are all eventually recoverable). Hard throw, not a log line,
    // checked against the same hardcoded constant used to build the
    // value in the first place — this catches a DIFFERENT code path
    // accidentally computing a wrong value, not re-deriving the same bug.
    if (forwarderBytes32.length !== 32) {
      throw new Error("Stellar CctpForwarder address did not encode to exactly 32 bytes — refusing to burn");
    }
    // @circle-fin/adapter-solana-kit's own depositForBurnWithHook builder
    // (index.mjs's buildInstructions$2, traced live after a real "Non-base58
    // character" failure on a Solana-sourced send, 2026-09-01) has a real
    // asymmetry: mintRecipient gets 0x-hex handling
    // (`mintRecipient.startsWith('0x') ? new PublicKey(Buffer.from(...)) :
    // new PublicKey(mintRecipient)`), but destinationCaller does NOT — it's
    // passed straight into `new PublicKey(destinationCaller ?? ...)`, which
    // treats a plain string as base58 and throws on our 0x-prefixed hex
    // (the literal "0" and "x" characters aren't valid base58). The EVM
    // adapter (viem) wants hex either way — confirmed working there via the
    // earlier mainnet dry-run — so this only needs to branch for Solana.
    // getAddressDecoder() (from @solana/kit, already imported for Step B's
    // own address handling) is exactly a base58 encoder for raw bytes here.
    const forwarderEncoded =
      sourceChain === "solana"
        ? getAddressDecoder().decode(new Uint8Array(forwarderBytes32))
        : `0x${forwarderBytes32.toString("hex")}`;
    // The real recipient must be a genuine Stellar account address (G...),
    // never the forwarder's own contract address (C...) — that would mean
    // hookData ends up telling mint_and_forward to forward funds to
    // itself. Cheap, meaningful check before it's baked into hookData.
    if (!input.destinationAddress.startsWith("G") || input.destinationAddress === contracts.cctpForwarder) {
      throw new Error(`"${input.destinationAddress}" doesn't look like a real Stellar recipient account — refusing to burn`);
    }

    const amountBaseUnits = parseUnits(input.amount, EVM_SOLANA_USDC_DECIMALS).toString();
    const signerAddress = await getSignerAddressForChain(sourceChain);
    const adapter = await getAdapterForChain(sourceChain);
    const ctx = { chain: sourceChainDef, address: signerAddress };

    // approve first, same as every other CCTP leg (a no-op internally on
    // Solana, which has no ERC-20-style approve step — mirrors
    // cctpBridge.ts's initiateCctpBurn exactly).
    const approvePrepared = (await provider.approve(
      { adapter, address: signerAddress, chain: sourceChainDef } as Parameters<typeof provider.approve>[0],
      amountBaseUnits,
    )) as Prepared;
    await executePrepared(sourceChain, approvePrepared);

    const hookData = buildStellarForwardHookData(input.destinationAddress);
    const hookDataHex = `0x${hookData.toString("hex")}`;

    // The lower-level action API — NOT provider.burn()'s convenience
    // wrapper, which computes mintRecipient itself via
    // getMintRecipientAccount() and has no Stellar branch (confirmed by
    // tracing the compiled SDK source — see the plan doc's own
    // refutation of the useForwarder shortcut for the same reason).
    // prepareAction lets us pass mintRecipient/destinationCaller/hookData
    // as raw strings we compute ourselves, bypassing that entirely.
    // Verified live (2026-08-31, throwaway key, prepare-only, no
    // broadcast) that this construction succeeds with a hand-built
    // Stellar chain definition and this exact hookData format.
    const typedAdapter = adapter as unknown as {
      prepareAction(action: string, params: unknown, ctx: { chain: unknown; address: string }): Promise<Prepared>;
    };
    const burnActionParams = {
      amount: BigInt(amountBaseUnits),
      mintRecipient: forwarderEncoded,
      destinationCaller: forwarderEncoded,
      maxFee: 0n,
      minFinalityThreshold: 1000, // FAST — matches cctpBridge.ts's own transferSpeed choice
      fromChain: sourceChainDef,
      toChain: getStellarChainDefinition(),
      hookData: hookDataHex,
    };

    // A dropped-transaction timeout is a real, confirmed live failure mode
    // here (2026-09-01, Solana-sourced burn): @circle-fin/adapter-solana-kit
    // never attaches a Solana priority fee for a server-side (non-browser-
    // wallet) signer in any version — traced through 1.6.1, the latest —
    // so under real mainnet congestion a broadcast transaction can miss its
    // ~60-90s blockhash window and simply never land. Confirmed live (via
    // direct getSignatureStatuses/getTransaction RPC calls) that a dropped
    // tx never touches chain state, so retrying from scratch is safe — a
    // fresh prepareAction call generates both a new blockhash and a new
    // ephemeral messageSentEventData keypair, not a resubmission of the
    // same doomed transaction. Matched narrowly on this exact message (not
    // a blanket retry-on-any-error) so a real revert or validation failure
    // still surfaces immediately instead of being retried pointlessly.
    const MAX_BURN_ATTEMPTS = 3;
    let burnTxHash: string | null = null;
    for (let attempt = 1; attempt <= MAX_BURN_ATTEMPTS; attempt++) {
      try {
        const burnPrepared = (await typedAdapter.prepareAction("cctp.v2.depositForBurnWithHook", burnActionParams, ctx)) as Prepared;
        burnTxHash = await executePrepared(sourceChain, burnPrepared);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isDroppedTxTimeout = /not confirmed on-chain within/i.test(message);
        if (!isDroppedTxTimeout || attempt === MAX_BURN_ATTEMPTS) throw err;
      }
    }
    if (!burnTxHash) throw new Error(`depositForBurnWithHook returned no transaction hash for ${sourceChain}`);

    const bridgeReference: StellarCctpBridgeReference = {
      direction: "toStellar",
      sourceChain,
      destinationAddress: input.destinationAddress,
      burnTxHash,
    };
    return { sourceTxHash: burnTxHash, bridgeReference: bridgeReference as unknown as Record<string, unknown> };
  },

  async checkStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult> {
    // The poller injects the DB's own destinationTxHash column onto this
    // object under the literal key `destinationTxHash` on every tick (see
    // crossChainSendConfirmationPoller.ts's advanceCrossChainSend) — the
    // SAME convention cctpBridge.ts's checkCctpStatus already checks
    // (`ref.destinationTxHash`). An earlier version of this function
    // checked a locally-invented `stellarMintTxHash` field that the poller
    // never populates, which meant it always re-submitted mint_and_forward
    // on every tick, forever, even after the mint already confirmed.
    const direction = (bridgeReference as { direction?: string }).direction ?? "toStellar";
    if (direction === "fromStellar") {
      return checkStatusFromStellar(bridgeReference as unknown as StellarSourceBridgeReference & { destinationTxHash?: string });
    }
    const ref = bridgeReference as unknown as StellarCctpBridgeReference & { destinationTxHash?: string };

    if (!ref.destinationTxHash) {
      const burnStatus = await checkTxConfirmed(ref.sourceChain, ref.burnTxHash);
      if (burnStatus === "pending") return { phase: "SOURCE_PENDING" };
      if (burnStatus === "reverted") return { phase: "FAILED", detail: "source_burn_reverted" };

      const adapter = await getAdapterForChain(ref.sourceChain);
      const sourceChainDef = getChainDefinition(ref.sourceChain);
      if (!sourceChainDef) throw new Error(`${ref.sourceChain} has no CCTP chain definition registered`);
      const signerAddress = await getSignerAddressForChain(ref.sourceChain);

      // Same bounded, single-attempt attestation check cctpBridge.ts's
      // own checkCctpStatus uses — "not ready" is the expected, common
      // outcome of most ticks, not an error.
      let attestation: Awaited<ReturnType<typeof provider.fetchAttestation>>;
      try {
        attestation = await provider.fetchAttestation(
          { adapter, address: signerAddress, chain: sourceChainDef } as Parameters<typeof provider.fetchAttestation>[0],
          ref.burnTxHash,
          { maxRetries: 1, timeout: 5_000 },
        );
      } catch {
        return { phase: "ATTESTATION_PENDING" };
      }
      if (attestation.status !== "complete") {
        return { phase: "ATTESTATION_PENDING" };
      }

      // The one step this leg has that no other CCTP pair needs: WE must
      // submit mint_and_forward ourselves (verified live against Circle's
      // real docs — no automatic relay exists for this specific call,
      // unlike the SDK's own useForwarder/Orbit-relayer mechanism, which
      // doesn't support Stellar at all — see the plan doc). This only
      // ever relays whatever recipient was already encoded in hookData at
      // burn time; a mistake here fails safely, it can't misdirect funds.
      const contracts = getStellarCctpContracts();
      const messageBytes = Buffer.from(attestation.message.replace(/^0x/, ""), "hex");
      const attestationBytes = Buffer.from(attestation.attestation.replace(/^0x/, ""), "hex");
      const submitted = await submitStellarContractCall(contracts.cctpForwarder, "mint_and_forward", [
        nativeToScVal(messageBytes, { type: "bytes" }),
        nativeToScVal(attestationBytes, { type: "bytes" }),
      ]);

      return {
        phase: "DESTINATION_PENDING",
        destinationTxHash: submitted.hash,
        detail: "stellar_mint_and_forward_broadcast",
      };
    }

    // mint_and_forward already broadcast on an earlier tick — check its
    // own confirmation. A failure here is the STUCK case (see the
    // poller's own risk-handling comment): the source burn already
    // confirmed, real and final, so this must never fall back to
    // FAILED/auto-refund.
    const mintStatus = await checkStellarTxStatus(ref.destinationTxHash);
    if (mintStatus === "pending") return { phase: "DESTINATION_PENDING", destinationTxHash: ref.destinationTxHash };
    if (mintStatus === "failed") {
      return { phase: "FAILED", destinationTxHash: ref.destinationTxHash, detail: "stellar_mint_and_forward_failed" };
    }
    return { phase: "DESTINATION_CONFIRMED", destinationTxHash: ref.destinationTxHash };
  },
};
