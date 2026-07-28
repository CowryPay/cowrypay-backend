/**
 * On-chain + optional HTTP smoke test.
 *
 * Usage:
 *   cp .env.example .env
 *   # set MONAD_RPC_URL (or RPC_URL), optionally CHAIN_ID, INTEGRATION_*
 *   npm run test:integration
 *
 * Optional:
 *   INTEGRATION_BASE_URL=http://127.0.0.1:3001  # with `npm run dev` in another terminal
 *   INTEGRATION_WALLET=0x…                      # checks registration + group list
 *   INTEGRATION_TEST_USERNAME=alice             # username to resolve (3–32 a-z0-9)
 */
import "dotenv/config";
import { isAddress } from "viem";
import { makePublicClient } from "@cowry/agent-core/chain/client.js";
import {
  formatGroupsLinesForWallet,
  isWalletRegisteredOnChain,
  readUsdcAddress,
  resolveUsernameOnChain,
} from "@cowry/agent-core/chain/reads.js";
import { createResolutionDeps } from "@cowry/agent-core/deps/createDeps.js";

async function main() {
  const rpc =
    process.env.MONAD_RPC_URL?.trim() || process.env.RPC_URL?.trim() || "";
  if (!rpc) {
    console.error(
      "Missing MONAD_RPC_URL or RPC_URL. Add one to .env for chain integration.",
    );
    process.exit(1);
  }

  const chainId = Number(process.env.CHAIN_ID || 10143);
  console.log("— Chain reads —");
  console.log("RPC:", rpc.slice(0, 48) + (rpc.length > 48 ? "…" : ""));
  console.log("CHAIN_ID:", chainId);

  const client = makePublicClient(rpc, chainId);
  const block = await client.getBlockNumber();
  console.log("Latest block:", block.toString());

  const usdc = await readUsdcAddress(client);
  console.log("CowryPay USDC:", usdc);

  const testName =
    process.env.INTEGRATION_TEST_USERNAME?.trim() || "zznonexistent999";
  const resolved = await resolveUsernameOnChain(client, testName);
  console.log(`UsernameRegistry getAddressByName("${testName}"):`);
  console.log(
    resolved.ok
      ? `  → ${resolved.address} (@${resolved.username})`
      : `  → not registered (${resolved.reason})`,
  );

  const w = process.env.INTEGRATION_WALLET?.trim();
  if (w && isAddress(w)) {
    const wallet = w as `0x${string}`;
    const reg = await isWalletRegisteredOnChain(client, wallet);
    console.log(`Wallet ${wallet.slice(0, 10)}… registered:`, reg);
    const lines = await formatGroupsLinesForWallet(client, wallet);
    console.log(lines.split("\n").slice(0, 8).join("\n"));
    if (lines.split("\n").length > 8) console.log("  …");
  } else if (w) {
    console.warn("INTEGRATION_WALLET is not a valid address; skipping wallet checks.");
  }

  console.log("\n— Resolution deps mode —");
  const deps = createResolutionDeps();
  console.log("createResolutionDeps():", deps.mode);
  if (deps.mode !== "chain") {
    console.error("Expected chain mode when RPC is set (check env loading).");
    process.exit(1);
  }

  const base = process.env.INTEGRATION_BASE_URL?.trim();
  if (base) {
    console.log("\n— HTTP —");
    const healthUrl = `${base.replace(/\/$/, "")}/health`;
    const h = await fetch(healthUrl);
    if (!h.ok) {
      console.error("GET", healthUrl, "→", h.status);
      process.exit(1);
    }
    const hj = (await h.json()) as { ok?: boolean; mode?: string };
    console.log("GET /health →", hj);

    const chatUrl = `${base.replace(/\/$/, "")}/chat`;
    const body = {
      sessionId: "integration-smoke",
      message: "help",
      ...(w && isAddress(w) ? { walletAddress: w } : {}),
    };
    const c = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!c.ok) {
      console.error("POST /chat →", c.status, await c.text());
      process.exit(1);
    }
    const cj = (await c.json()) as { type?: string };
    console.log("POST /chat { message: \"help\" } → type:", cj.type);
  } else {
    console.log(
      "\n(No INTEGRATION_BASE_URL — start `npm run dev` and set INTEGRATION_BASE_URL=http://127.0.0.1:3001 to hit /health and /chat.)",
    );
  }

  console.log("\n✅ Integration smoke finished.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
