import { Contract, TransactionBuilder, Networks, Address, nativeToScVal, xdr, rpc, Asset } from "@stellar/stellar-sdk";
import { env } from "../../../config/env.js";
import { getStellarSigningKeypair } from "../../wallets/stellarKms.js";
import { withAdvisoryLock } from "../../../db/advisoryLock.js";

// Stellar USDC uses 7 decimals — every other chain in this codebase's CCTP
// integration (cctpBridge.ts's CCTP_USDC_DECIMALS) uses 6. Do not reuse
// that constant here; this one is deliberately separate.
export const STELLAR_USDC_DECIMALS = 7;
export const STELLAR_CCTP_DOMAIN = 27;

const networkPassphrase = env.stellarNetwork === "public" ? Networks.PUBLIC : Networks.TESTNET;

// Verified live against developers.circle.com/cctp/references/stellar-contracts
// (2026-08-31) — protocol constants, not secrets, so hardcoded here (a wrong
// address is a code-review question, not an env-var-typo risk) rather than
// added as new env vars, mirroring how networkPassphrase above is already
// derived from env.stellarNetwork rather than configured separately.
const STELLAR_CCTP_CONTRACTS = {
  public: {
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    cctpForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  },
  testnet: {
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
} as const;

export function getStellarCctpContracts() {
  return env.stellarNetwork === "public" ? STELLAR_CCTP_CONTRACTS.public : STELLAR_CCTP_CONTRACTS.testnet;
}

// A hand-built ChainDefinitionWithCCTPv2-shaped object for Stellar — no
// official one exists from Circle (confirmed: @circle-fin/bridge-kit
// declares a Stellar chain constant in its TYPE definitions but it's not
// exported at runtime, and even that aspirational declaration has
// cctp: null). Used as the `toChain` of a depositForBurnWithHook action on
// the EVM/Solana source side (Base/Optimism/Solana -> Stellar) to embed the
// correct destination domain (27) in the burn message, AND as the
// `source.chain` of a stub WalletContext for provider.fetchAttestation()/
// provider.mint() when Stellar is the SOURCE (Stellar -> Base/Solana) — see
// stellarCctpAdapter.ts's Stellar-as-source checkStatus(). We never route an
// actual mint/burn through this object's own adapter/contracts in either
// direction (Stellar transactions are always hand-submitted separately via
// submitStellarContractCall, not through this SDK at all).
export function getStellarChainDefinition() {
  const contracts = getStellarCctpContracts();
  return {
    type: "stellar" as const,
    chain: "Stellar",
    name: "Stellar",
    nativeCurrency: { name: "Stellar Lumens", symbol: "XLM", decimals: 7 },
    isTestnet: env.stellarNetwork !== "public",
    explorerUrl: "https://stellar.expert/explorer/public/tx/{hash}",
    rpcEndpoints: [env.stellarHorizonUrl],
    eurcAddress: null,
    // Real value, not null — required for Stellar to pass as a `source.chain`
    // WalletContext: @circle-fin/provider-cctp-v2's assertCCTPv2WalletContext
    // (traced in compiled source) hard-throws "Does not have USDC configured"
    // when usdcAddress is null, and Stellar only becomes `source.chain` once
    // it's used as the burn side (Stellar-as-source). Harmless for the
    // existing toChain usage above — nothing reads .chain.usdcAddress on the
    // destination side in any code path this codebase actually calls (the
    // one function that does, assertCCTPv2AttestationParams, belongs to the
    // SDK's own high-level orchestrator, which this codebase deliberately
    // never uses — see the plan doc's useForwarder refutation). A Soroban
    // contract strkey here matches how other non-EVM chains in the SDK's own
    // table represent this field in their native format (Solana: base58
    // mint address, Algorand: decimal asset ID) — not a new convention.
    usdcAddress: getStellarUsdcContractId(),
    usdtAddress: null,
    cctp: {
      domain: STELLAR_CCTP_DOMAIN,
      contracts: {
        v2: {
          type: "split" as const,
          tokenMessenger: contracts.tokenMessengerMinter,
          messageTransmitter: contracts.messageTransmitter,
          confirmations: 1,
          fastConfirmations: 1,
        },
      },
    },
  };
}

// Not published as a separate address by Circle — derived from the same
// classic-asset issuer stellarAdapter.ts already uses (env.stellarUsdcIssuer),
// via the installed SDK's own deterministic Stellar-Asset-Contract derivation.
// Cached since it never changes for a given issuer/network.
let cachedUsdcContractId: string | null = null;
export function getStellarUsdcContractId(): string {
  if (cachedUsdcContractId) return cachedUsdcContractId;
  if (!env.stellarUsdcIssuer) {
    throw new Error("STELLAR_USDC_ISSUER must be set to use Stellar CCTP");
  }
  cachedUsdcContractId = new Asset("USDC", env.stellarUsdcIssuer).contractId(networkPassphrase);
  return cachedUsdcContractId;
}

let cachedServer: rpc.Server | null = null;
function getSorobanServer(): rpc.Server {
  if (!cachedServer) cachedServer = new rpc.Server(env.stellarSorobanRpcUrl);
  return cachedServer;
}

// Zero-pads a 20-byte EVM address or 32-byte Solana pubkey up to CCTP's
// bytes32 mint-recipient/destination-caller convention — the same
// left-padding convention cctpBridge.ts already relies on implicitly via
// the SDK's own (unexported) address-to-bytes32 conversion for the other
// three chains. Reimplemented here since that helper isn't exported.
export function addressToBytes32(rawBytes: Uint8Array): Buffer {
  if (rawBytes.length > 32) throw new Error(`Address is longer than 32 bytes (${rawBytes.length})`);
  const padded = Buffer.alloc(32);
  Buffer.from(rawBytes).copy(padded, 32 - rawBytes.length);
  return padded;
}

// The hookData format Stellar's CctpForwarder specifically expects — NOT
// the same "cctp-forward" ASCII marker Circle's own (Solana/EVM-oriented)
// useForwarder/Orbit-relayer mechanism uses internally (confirmed those are
// two unrelated mechanisms sharing only a name — see this feature's plan
// doc). Verified live against developers.circle.com/cctp/references/stellar
// (2026-08-31): bytes 0-23 are Circle-reserved all-zero magic, bytes 24-27
// are a version (0), bytes 28-31 are the byte-length of what follows, bytes
// 32+ are the literal ASCII forwardRecipient strkey (a real G... address
// string, not a hash or further encoding).
export function buildStellarForwardHookData(forwardRecipientStrkey: string): Buffer {
  const recipientBytes = Buffer.from(forwardRecipientStrkey, "ascii");
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0, 24); // version
  header.writeUInt32BE(recipientBytes.length, 28); // length of what follows
  return Buffer.concat([header, recipientBytes]);
}

export interface StellarSubmitResult {
  hash: string;
  status: string;
}

// Build, simulate (server.prepareTransaction — Soroban's simulate-before-
// submit model, which fails cleanly with no funds at risk if a param is
// wrong, unlike a classic payment's submit-and-find-out), sign, and
// broadcast a Soroban contract invocation. Returns immediately after
// broadcast — deliberately does NOT wait for confirmation, matching this
// codebase's broadcast-then-poll architecture everywhere else (see
// cctpBridge.ts's own comment on why the SDK's blocking convenience
// methods are avoided). checkStellarTxStatus below is what the poller
// calls repeatedly afterward.
//
// Serialized against the SAME "stellar-sequence" advisory lock
// stellarAdapter.ts's classic-payment withdraw() already uses — a Soroban
// invocation consumes the shared treasury account's sequence number
// exactly like a classic payment does, so the two must never race each
// other, not just race amongst themselves.
export async function submitStellarContractCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<StellarSubmitResult> {
  const keypair = await getStellarSigningKeypair();
  const server = getSorobanServer();

  return withAdvisoryLock("stellar-sequence", async () => {
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);

    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw new Error(`Soroban ${method} submission failed: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
    }
    return { hash: sendResult.hash, status: sendResult.status };
  });
}

// Single, bounded status check — called repeatedly by the poller, never
// blocks waiting for finality itself. Mirrors cctpBridge.ts's own
// checkTxConfirmed in shape (a chain-specific "pending"/"success"/"reverted"
// answer for one tick), just against Soroban's own getTransaction shape
// instead of an EVM/Solana receipt.
export async function checkStellarTxStatus(hash: string): Promise<"pending" | "success" | "failed"> {
  const server = getSorobanServer();
  const result = await server.getTransaction(hash);
  if (result.status === "SUCCESS") return "success";
  if (result.status === "FAILED") return "failed";
  return "pending"; // NOT_FOUND (not yet ingested) or genuinely still pending
}

export { nativeToScVal, Address, xdr };
