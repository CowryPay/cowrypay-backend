/**
 * Register the Cowry agent on the ERC-8004 Identity Registry indexed by 8004scan.
 *
 * Uses the SAME wallet as AGENT_PRIVATE_KEY (e.g. 0x6143…) — no new address is created.
 * This is separate from Self Agent ID (registry 0xaC3DF9…); you keep Self NFT #112 and
 * get a new agentId on 8004scan's registry (0x8004A169…).
 *
 * Prerequisites:
 *   AGENT_PRIVATE_KEY=0x...  (agent wallet with CELO for gas)
 *   CELO_RPC_URL             (optional, default https://forno.celo.org)
 *
 * Run: npm run register:8004scan
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
} from "viem";
import { celo } from "viem/chains";

import {
  getAgentIdStatus,
  SELF_AGENT_REGISTRY,
} from "../src/agent/selfId.js";

/** ERC-8004 Identity Registry on Celo mainnet (8004scan / AltLayer). */
export const ERC8004_IDENTITY_REGISTRY =
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

const CELO_CHAIN_ID = 42220;

const IDENTITY_REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "setAgentURI",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAgentWallet",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "URIUpdated",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "newURI", type: "string", indexed: false },
      { name: "updatedBy", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

function buildAgentRegistrationFile(opts: {
  name: string;
  description: string;
  agentAddress: `0x${string}`;
  apiUrl?: string;
  selfAgentId?: bigint;
}) {
  const services: Array<Record<string, string | number>> = [
    {
      name: "wallet",
      endpoint: opts.agentAddress,
      chainId: CELO_CHAIN_ID,
    },
  ];
  if (opts.apiUrl) {
    services.push({
      name: "a2a",
      endpoint: `${opts.apiUrl.replace(/\/$/, "")}/agent/info`,
    });
  }

  const registrations: Array<{ agentRegistry: string; agentId: number }> = [];
  if (opts.selfAgentId !== undefined && opts.selfAgentId > 0n) {
    registrations.push({
      agentRegistry: `eip155:${CELO_CHAIN_ID}:${SELF_AGENT_REGISTRY}`,
      agentId: Number(opts.selfAgentId),
    });
  }

  return {
    type: "Agent",
    name: opts.name,
    description: opts.description,
    services,
    ...(registrations.length > 0 ? { registrations } : {}),
    supportedTrust: ["reputation", "tee"],
    tags: ["celo", "payments", "remittance", "cross-chain", "minipay", "self-verified"],
    categories: ["payments", "defi"],
  };
}

const forceUpdate =
  process.argv.includes("--update") ||
  process.env.AGENT_8004_UPDATE?.trim() === "1" ||
  process.env.AGENT_8004_UPDATE?.trim()?.toLowerCase() === "true";

function toDataUri(json: object): string {
  const b64 = Buffer.from(JSON.stringify(json), "utf8").toString("base64");
  return `data:application/json;base64,${b64}`;
}

function formatCelo(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 14n; // 4 decimal places
  return `${whole}.${frac.toString().padStart(4, "0")} CELO`;
}

async function estimateTxCostWei(
  publicClient: ReturnType<typeof createPublicClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  params: {
    address: `0x${string}`;
    abi: typeof IDENTITY_REGISTRY_ABI;
    functionName: "register" | "setAgentURI";
    args: readonly unknown[];
  },
): Promise<bigint> {
  const gas = await publicClient.estimateContractGas({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args as never,
    account: account.address,
  });
  const fees = await publicClient.estimateFeesPerGas();
  const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  return ((gas * 110n) / 100n) * maxFee;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Registry proxy deployed on Celo mainnet (Feb 2026). */
const REGISTRY_DEPLOY_BLOCK = 58_396_724n;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNonexistentTokenError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("0x7e273289") || msg.includes("ERC721NonexistentToken");
}

async function waitForOwnerOf(
  publicClient: ReturnType<typeof createPublicClient>,
  agentId: bigint,
  owner: `0x${string}`,
  maxAttempts = 20,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const actual = await publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [agentId],
      });
      if (actual.toLowerCase() === owner.toLowerCase()) return;
    } catch {
      // RPC may lag behind mint receipt
    }
    await sleep(1500);
  }
  throw new Error(
    `Token ${agentId} not visible on RPC after mint — wait ~30s and re-run (AGENT_8004_ID=${agentId}).`,
  );
}

async function resolveOwnedAgentId(
  publicClient: ReturnType<typeof createPublicClient>,
  owner: `0x${string}`,
): Promise<bigint | undefined> {
  const fromEnv = process.env.AGENT_8004_ID?.trim();
  if (fromEnv && /^\d+$/.test(fromEnv)) {
    const id = BigInt(fromEnv);
    try {
      const actual = await publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [id],
      });
      if (actual.toLowerCase() === owner.toLowerCase()) return id;
    } catch {
      // fall through to log scan
    }
  }

  const logs = await publicClient.getLogs({
    address: ERC8004_IDENTITY_REGISTRY,
    event: {
      type: "event",
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "tokenId", type: "uint256", indexed: true },
      ],
    },
    args: { to: owner, from: ZERO },
    fromBlock: REGISTRY_DEPLOY_BLOCK,
    toBlock: "latest",
  });

  if (logs.length === 0) return undefined;
  return logs[logs.length - 1]!.args.tokenId!;
}

async function sendSimulatedContract(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  params: {
    address: `0x${string}`;
    abi: typeof IDENTITY_REGISTRY_ABI;
    functionName: "register" | "setAgentURI";
    args: readonly unknown[];
  },
): Promise<`0x${string}`> {
  const { request } = await publicClient.simulateContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args as never,
    account,
  });

  const gas =
    request.gas ??
    (await publicClient.estimateContractGas({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as never,
      account: account.address,
    }));

  return walletClient.writeContract({
    ...request,
    account,
    gas: request.gas ?? (gas * 110n) / 100n,
  });
}

async function setAgentURIWithRetry(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  agentId: bigint,
  agentURI: string,
  maxAttempts = 15,
): Promise<`0x${string}`> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await waitForOwnerOf(publicClient, agentId, account.address, 3);
      return await sendSimulatedContract(publicClient, walletClient, account, {
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "setAgentURI",
        args: [agentId, agentURI],
      });
    } catch (err) {
      if (isNonexistentTokenError(err) && attempt < maxAttempts) {
        process.stdout.write(`\n    RPC lag — retry setAgentURI (${attempt}/${maxAttempts})...`);
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("setAgentURI failed after retries");
}

async function poll8004scan(agentAddress: string, timeoutMs = 120_000): Promise<boolean> {
  const url = `https://8004scan.io/api/v1/agents?search=${agentAddress.toLowerCase()}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { total?: number; items?: unknown[] };
        if ((body.total ?? 0) > 0 || (body.items?.length ?? 0) > 0) return true;
      }
    } catch {
      // indexer may lag
    }
    await new Promise((r) => setTimeout(r, 8_000));
    process.stdout.write(".");
  }
  return false;
}

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk || !pk.startsWith("0x")) {
  console.error("❌  AGENT_PRIVATE_KEY is not set or not 0x-prefixed.");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const rpcUrl = process.env.CELO_RPC_URL ?? "https://forno.celo.org";

const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl) });
const walletClient = createWalletClient({
  account,
  chain: celo,
  transport: http(rpcUrl),
});

console.log("───────────────────────────────────────────");
console.log("  Cowry AI — 8004scan / ERC-8004 Registration");
console.log("───────────────────────────────────────────");
console.log("  Agent wallet   :", account.address);
console.log("  Identity reg.  :", ERC8004_IDENTITY_REGISTRY);
console.log("  Self reg.      :", SELF_AGENT_REGISTRY, "(linked in metadata)");
console.log();

const selfStatus = await getAgentIdStatus(publicClient, account.address);
const selfIdFromEnv = process.env.AGENT_SELF_ID?.trim();
const selfAgentId =
  selfStatus.registered
    ? selfStatus.agentId
    : selfIdFromEnv && /^\d+$/.test(selfIdFromEnv)
      ? BigInt(selfIdFromEnv)
      : undefined;

if (selfAgentId) {
  console.log("  Self Agent ID  :", selfAgentId.toString());
} else {
  console.log("  Self Agent ID  : (none linked in metadata)");
}

const agentName = process.env.AGENT_8004_NAME?.trim() || "Cowry AI Agent";
const agentDescription =
  process.env.AGENT_8004_DESCRIPTION?.trim() ||
  "Conversational crypto payments on Celo: send USDC to bank accounts abroad (Paycrest remittance), bridge to other chains (LI.FI), and onchain transfers via chat. Human-verified via Self Agent ID.";
const apiUrl = process.env.AGENT_API_URL?.trim() || process.env.PUBLIC_AGENT_URL?.trim();

const registrationJson = buildAgentRegistrationFile({
  name: agentName,
  description: agentDescription,
  agentAddress: account.address,
  apiUrl: apiUrl || undefined,
  selfAgentId,
});

const agentURI =
  process.env.AGENT_8004_URI?.trim() || toDataUri(registrationJson);

console.log();
console.log("    agentURI type :", agentURI.startsWith("data:") ? "on-chain data URI" : agentURI.slice(0, 60) + "...");

const existingBalance = await publicClient.readContract({
  address: ERC8004_IDENTITY_REGISTRY,
  abi: IDENTITY_REGISTRY_ABI,
  functionName: "balanceOf",
  args: [account.address],
});
if (existingBalance > 0n) {
  console.log(`  Existing NFTs  : ${existingBalance} on 8004scan registry`);
}

let agentId = await resolveOwnedAgentId(publicClient, account.address);
let uriHash: `0x${string}`;

if (agentId !== undefined) {
  const currentUri = await publicClient.readContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "tokenURI",
    args: [agentId],
  });
  if (forceUpdate) {
    console.log(`⏳  Updating metadata for agentId ${agentId} (--update)...`);
    const balance = await publicClient.getBalance({ address: account.address });
    let uriCost: bigint;
    try {
      uriCost = await estimateTxCostWei(publicClient, account, {
        address: ERC8004_IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "setAgentURI",
        args: [agentId, agentURI],
      });
    } catch {
      const uriBytes = BigInt(Buffer.byteLength(agentURI, "utf8"));
      const fees = await publicClient.estimateFeesPerGas();
      const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
      uriCost = ((100_000n + uriBytes * 200n) * 110n) / 100n * maxFee;
    }
    if (balance < uriCost + 10n ** 14n) {
      console.error(
        `❌  Insufficient CELO to update agentURI.\n` +
          `    Wallet balance : ${formatCelo(balance)}\n` +
          `    Estimated need : ${formatCelo(uriCost)}\n` +
          `    Send ~0.1 CELO to : ${account.address}\n` +
          `    Then re-run: npm run register:8004scan -- --update`,
      );
      process.exit(1);
    }
  } else {
    console.log(`⏳  NFT already minted (agentId ${agentId}); finishing metadata...`);
    if (currentUri.length > 0) {
      console.log(`✅  agentURI already set (${currentUri.length} chars).`);
      console.log(`  To refresh metadata: npm run register:8004scan -- --update`);
      console.log(`  Add to .env         : AGENT_8004_ID=${agentId}`);
      console.log(`  8004scan URL        : https://8004scan.io/agents/celo/${agentId}`);
      process.exit(0);
    }
  }

  const balance = await publicClient.getBalance({ address: account.address });
  let uriCost: bigint;
  try {
    uriCost = await estimateTxCostWei(publicClient, account, {
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "setAgentURI",
      args: [agentId, agentURI],
    });
  } catch {
    const uriBytes = BigInt(Buffer.byteLength(agentURI, "utf8"));
    const fees = await publicClient.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    uriCost = ((100_000n + uriBytes * 200n) * 110n) / 100n * maxFee;
  }
  if (balance < uriCost + 10n ** 14n) {
    console.error(
      `❌  Insufficient CELO to set agentURI (NFT #${agentId} already minted).\n` +
        `    Wallet balance : ${formatCelo(balance)}\n` +
        `    Estimated need : ${formatCelo(uriCost)} for setAgentURI\n` +
        `    Send ~0.05 CELO to : ${account.address}\n` +
        `    Then re-run (or set AGENT_8004_ID=${agentId} in .env).`,
    );
    process.exit(1);
  }
} else {
  console.log("⏳  Minting ERC-8004 identity NFT (same wallet, new registry)...");

  const balance = await publicClient.getBalance({ address: account.address });
  const mintCost = await estimateTxCostWei(publicClient, account, {
    address: ERC8004_IDENTITY_REGISTRY,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [],
  });
  let uriCost: bigint;
  try {
    uriCost = await estimateTxCostWei(publicClient, account, {
      address: ERC8004_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [agentURI],
    });
  } catch {
    const uriBytes = BigInt(Buffer.byteLength(agentURI, "utf8"));
    const fees = await publicClient.estimateFeesPerGas();
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    uriCost = ((100_000n + uriBytes * 200n) * 130n) / 100n * maxFee;
  }
  const requiredWei = mintCost + uriCost + 10n ** 15n;
  if (balance < requiredWei) {
    console.error(
      `❌  Insufficient CELO for gas.\n` +
        `    Wallet balance : ${formatCelo(balance)}\n` +
        `    Estimated need : ${formatCelo(requiredWei)} (mint + setAgentURI + buffer)\n` +
        `    Send CELO to   : ${account.address}`,
    );
    process.exit(1);
  }

  console.log("    Step 1/2    : register() mint NFT...");
  const mintHash = await sendSimulatedContract(publicClient, walletClient, account, {
    address: ERC8004_IDENTITY_REGISTRY,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [],
  });
  console.log("    Mint tx     :", mintHash);

  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if (mintReceipt.status === "reverted") {
    console.error("❌  Mint transaction reverted.");
    process.exit(1);
  }

  const mintLogs = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: "Registered",
    logs: mintReceipt.logs,
  });
  const mintTransfers = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: "Transfer",
    logs: mintReceipt.logs,
  });

  agentId =
    mintLogs[0]?.args.agentId ??
    mintTransfers.find((l) => l.args.from === ZERO)?.args.tokenId;

  if (agentId === undefined) {
    console.error("❌  Could not parse agentId from mint receipt.");
    process.exit(1);
  }

  console.log("    Waiting for RPC to index new token...");
  await waitForOwnerOf(publicClient, agentId, account.address);
}

// Step 2: attach metadata URI (8004scan reads this)
console.log("    Step 2/2    : setAgentURI(...)");
uriHash = await setAgentURIWithRetry(
  publicClient,
  walletClient,
  account,
  agentId,
  agentURI,
);
console.log("    URI tx      :", uriHash);

const receipt = await publicClient.waitForTransactionReceipt({ hash: uriHash });
if (receipt.status === "reverted") {
  console.error("❌  setAgentURI reverted — NFT minted but metadata not set.");
  console.error(`    Agent ID ${agentId} exists; retry with AGENT_8004_ID=${agentId} and set URI manually.`);
  process.exit(1);
}

const hash = uriHash;

const agentWallet = await publicClient.readContract({
  address: ERC8004_IDENTITY_REGISTRY,
  abi: IDENTITY_REGISTRY_ABI,
  functionName: "getAgentWallet",
  args: [agentId],
});

console.log();
console.log("───────────────────────────────────────────");
console.log("✅  Registered on ERC-8004 Identity Registry!");
console.log(`  8004scan agentId : ${agentId}`);
console.log(`  Agent wallet     : ${account.address}`);
console.log(`  On-chain wallet  : ${agentWallet}`);
console.log(`  Add to .env      : AGENT_8004_ID=${agentId}`);
console.log(`  8004scan URL     : https://8004scan.io/agents/celo/${agentId}`);
console.log(`  Celo explorer    : https://celoscan.io/tx/${hash}`);
console.log("───────────────────────────────────────────");
console.log();
console.log("⏳  Waiting for 8004scan indexer (up to ~2 min)...");

const indexed = await poll8004scan(account.address);
console.log();
if (indexed) {
  console.log("✅  Visible on 8004scan search for your agent address.");
} else {
  console.log(
    "⚠️  On-chain registration succeeded; 8004scan may take a few minutes to index.",
  );
  console.log(`   Check: https://8004scan.io/agents/celo/${agentId}`);
}
