/**
 * One-time script to register the CowryPay AI agent with Self Agent ID (ERC-8004).
 *
 * What it does:
 * 1. Uses your deployer wallet as the human owner (AGENT_PRIVATE_KEY → humanAddress)
 * 2. Starts "linked" registration (Self API; replaces deprecated verified-wallet mode)
 * 3. Self generates a dedicated agent EVM key — prints deep link + optional QR PNG
 * 4. You complete ZK passport verification in the Self app
 * 5. Polls until the soulbound ERC-721 NFT is minted on Celo mainnet
 * 6. Exports the agent private key — you must set AGENT_PRIVATE_KEY to that key
 *
 * Prerequisites:
 *   AGENT_PRIVATE_KEY=0x... in .env (deployer / human wallet for registration)
 *   CELO_RPC_URL=https://forno.celo.org  (optional)
 *
 * Run: npm run register:agent
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { requestRegistration } from "@selfxyz/agent-sdk";
import { getAgentIdStatus, SELF_AGENT_REGISTRY } from "@cowry/agent-core/agent/selfId.js";

const POLL_TIMEOUT_MS = 30 * 60 * 1_000; // match Self API default session TTL

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk || !pk.startsWith("0x")) {
  console.error("❌  AGENT_PRIVATE_KEY is not set or not 0x-prefixed.");
  process.exit(1);
}

const humanAccount = privateKeyToAccount(pk as `0x${string}`);
const rpcUrl = process.env.CELO_RPC_URL ?? "https://forno.celo.org";
const client = createPublicClient({ chain: celo, transport: http(rpcUrl) });

console.log("───────────────────────────────────────────");
console.log("  CowryPay AI — Self Agent ID Registration");
console.log("───────────────────────────────────────────");
console.log("  Human wallet  :", humanAccount.address);
console.log("  Network       : Celo Mainnet");
console.log("  Registry      :", SELF_AGENT_REGISTRY);
console.log("  Mode          : linked (human owns NFT; agent gets its own key)");
console.log();

// If an agent key was already registered for this human, check agents via human wallet
const humanStatus = await getAgentIdStatus(client, humanAccount.address);
if (humanStatus.registered) {
  console.log(`✅  Human wallet already has a verified agent key — Agent NFT ID: ${humanStatus.agentId}`);
  console.log("    (If you use linked mode, ensure AGENT_PRIVATE_KEY is the agent key, not only the human wallet.)");
  process.exit(0);
}

console.log("⏳  Initiating registration with Self Protocol...");

const session = await requestRegistration({
  mode: "linked",
  network: "mainnet",
  humanAddress: humanAccount.address,
  agentName: "CowryPay AI Agent",
  disclosures: { ofac: true },
});

const agentAddress = session.agentAddress as `0x${string}`;
const agentStatus = await getAgentIdStatus(client, agentAddress);
if (agentStatus.registered) {
  console.log(`✅  Agent already registered — Agent NFT ID: ${agentStatus.agentId}`);
  console.log(`  Agent address : ${agentAddress}`);
  process.exit(0);
}

console.log();
console.log("  Agent address (on-chain identity):", agentAddress);
console.log("  Human wallet (NFT owner)         :", humanAccount.address);
console.log();
if (session.humanInstructions?.length) {
  for (const line of session.humanInstructions) console.log("  •", line);
  console.log();
}
console.log("📱  Open this link on your phone (tap → opens Self app):");
console.log();
console.log("  ➜", session.deepLink);
console.log();

console.log(`⏳  Waiting for passport verification (timeout: ${POLL_TIMEOUT_MS / 60_000} min)...`);
console.log("    (Complete the Self app flow on your phone; this script polls Celo for the NFT mint.)");
console.log();

const deadline = Date.now() + POLL_TIMEOUT_MS;
let registered = false;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5_000));
  const status = await getAgentIdStatus(client, agentAddress);
  if (status.registered) {
    registered = true;
    console.log();
    console.log("───────────────────────────────────────────");
    console.log("✅  Registration complete!");
    console.log(`  Agent NFT ID  : ${status.agentId}`);
    console.log(`  Agent address : ${status.agentAddress}`);
    console.log(`  Human wallet  : ${humanAccount.address}`);
    console.log(`  Add to .env   : AGENT_SELF_ID=${status.agentId}`);
    console.log();
    console.log("  ⚠️  Linked mode uses a NEW agent key (separate from your deployer key).");
    console.log("  After registration, set AGENT_PRIVATE_KEY to the agent key from:");
    console.log("  https://self-agent-id.vercel.app  (session export) or your registration UI.");
    console.log(`  The on-chain agent address to fund/use is: ${agentAddress}`);
    console.log("  Keep your deployer key elsewhere for contract admin if needed.");
    console.log("───────────────────────────────────────────");
    break;
  }
  process.stdout.write(".");
}

if (!registered) {
  console.error("\n❌  Timed out waiting for on-chain registration. Finish the Self app flow and run again.");
  console.error("    If you already scanned, wait a minute and re-run: npm run register:agent");
  process.exit(1);
}

// Best-effort export of generated agent key (API may require browser handoff)
try {
  const agentPrivateKey = await session.exportKey();
  console.log();
  console.log("  Exported agent key — update ai-agent-service/.env:");
  console.log(`  AGENT_PRIVATE_KEY=${agentPrivateKey}`);
} catch {
  // On-chain registration succeeded; key export is optional if user copies key elsewhere
}
