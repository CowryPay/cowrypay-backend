import { CCTPV2BridgingProvider } from "@circle-fin/provider-cctp-v2";
import { parseUnits } from "viem";
import { Address as StellarAddress } from "@stellar/stellar-sdk";
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
  submitStellarContractCall,
  checkStellarTxStatus,
  addressToBytes32,
  buildStellarForwardHookData,
  nativeToScVal,
} from "./stellarCctpSoroban.js";
import type { BridgeAdapter, BridgeInitiateInput, BridgeInitiateResult, BridgePhaseCheckResult, BridgeQuote } from "./adapter.js";

// Same USDC-is-always-6-decimals assumption cctpBridge.ts's own
// CCTP_USDC_DECIMALS makes for the EVM/Solana side of a transfer — kept
// as a local copy rather than importing that unexported constant, since
// it's a protocol fact (not configuration) safe to state twice. Stellar's
// OWN side of the transfer uses 7 decimals — see stellarCctpSoroban.ts's
// STELLAR_USDC_DECIMALS, used only once Phase B (Stellar as source) is
// built; this file (Phase A, Stellar as destination) never burns on the
// Stellar side, so it never needs that constant.
const EVM_SOLANA_USDC_DECIMALS = 6;

// Phase A only: base/optimism/solana -> stellar. Phase B (stellar as
// SOURCE) needs Soroban deposit_for_burn, not yet built — see the plan
// doc's phasing. supports() must be the honest "can this actually go
// through right now" answer, not just "is there data about this pair
// somewhere" — same principle cctpAdapter.ts's own SUPPORTED_CHAINS
// comment establishes elsewhere in this codebase.
const NON_STELLAR_SOURCE_CHAINS = new Set(["base", "optimism", "solana"]);

const provider = new CCTPV2BridgingProvider();

interface StellarCctpBridgeReference {
  sourceChain: string;
  destinationAddress: string; // the real Stellar recipient (a G... strkey)
  burnTxHash: string;
  // Set once mint_and_forward has been submitted on Stellar.
  stellarMintTxHash?: string;
}

export const stellarCctpAdapter: BridgeAdapter = {
  supports(sourceChain: string, destinationChain: string): boolean {
    return NON_STELLAR_SOURCE_CHAINS.has(sourceChain.toLowerCase()) && destinationChain.toLowerCase() === "stellar";
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
    const forwarderHex = `0x${forwarderBytes32.toString("hex")}`;
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
    const burnPrepared = (await (
      adapter as unknown as {
        prepareAction(
          action: string,
          params: unknown,
          ctx: { chain: unknown; address: string },
        ): Promise<Prepared>;
      }
    ).prepareAction(
      "cctp.v2.depositForBurnWithHook",
      {
        amount: BigInt(amountBaseUnits),
        mintRecipient: forwarderHex,
        destinationCaller: forwarderHex,
        maxFee: 0n,
        minFinalityThreshold: 1000, // FAST — matches cctpBridge.ts's own transferSpeed choice
        fromChain: sourceChainDef,
        toChain: getStellarChainDefinition(),
        hookData: hookDataHex,
      },
      ctx,
    )) as Prepared;

    const burnTxHash = await executePrepared(sourceChain, burnPrepared);
    if (!burnTxHash) throw new Error(`depositForBurnWithHook returned no transaction hash for ${sourceChain}`);

    const bridgeReference: StellarCctpBridgeReference = {
      sourceChain,
      destinationAddress: input.destinationAddress,
      burnTxHash,
    };
    return { sourceTxHash: burnTxHash, bridgeReference: bridgeReference as unknown as Record<string, unknown> };
  },

  async checkStatus(bridgeReference: Record<string, unknown>): Promise<BridgePhaseCheckResult> {
    const ref = bridgeReference as unknown as StellarCctpBridgeReference;

    if (!ref.stellarMintTxHash) {
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
    const mintStatus = await checkStellarTxStatus(ref.stellarMintTxHash);
    if (mintStatus === "pending") return { phase: "DESTINATION_PENDING", destinationTxHash: ref.stellarMintTxHash };
    if (mintStatus === "failed") {
      return { phase: "FAILED", destinationTxHash: ref.stellarMintTxHash, detail: "stellar_mint_and_forward_failed" };
    }
    return { phase: "DESTINATION_CONFIRMED", destinationTxHash: ref.stellarMintTxHash };
  },
};
