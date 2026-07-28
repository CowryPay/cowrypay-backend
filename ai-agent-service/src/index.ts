import "dotenv/config";
import express, { type Request, type Response } from "express";
import { isAddress, isHash } from "viem";
import { createResolutionDeps } from "@cowry/agent-core/deps/createDeps.js";
import { handleUserMessage } from "@cowry/agent-core/pipeline.js";
import { createMessageParser } from "@cowry/agent-core/parseMessage.js";
import { fetchTxReceiptStatus } from "@cowry/agent-core/txStatus.js";
import { getAgentWallet } from "@cowry/agent-core/agent/wallet.js";
import { getAgentIdStatus } from "@cowry/agent-core/agent/selfId.js";
import {
  getBridgeQuote,
  getBridgeStatus,
  formatBridgeSummary,
  getCeloBridgeSource,
  getCeloOutboundDestinations,
} from "@cowry/agent-core/lifi/bridgeClient.js";

const app = express();
app.use(express.json());

const deps = createResolutionDeps();
const parseMessage = createMessageParser();

// ── Chat ─────────────────────────────────────────────────────────────────────

app.post("/chat", async (req: Request, res: Response) => {
  const sessionId =
    typeof req.body?.sessionId === "string" && req.body.sessionId
      ? req.body.sessionId
      : "default";
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message (string) required" });
    return;
  }
  const rawWallet = req.body?.walletAddress;
  const walletAddress =
    typeof rawWallet === "string" && isAddress(rawWallet)
      ? (rawWallet as `0x${string}`)
      : undefined;
  try {
    const out = await handleUserMessage(sessionId, message, deps, parseMessage, walletAddress);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, mode: deps.mode });
});

// ── Agent identity (ERC-8004 / Self Agent ID) ─────────────────────────────────

app.get("/agent/info", async (_req: Request, res: Response) => {
  try {
    const { address, publicClient } = getAgentWallet();
    const selfStatus = deps.publicClient
      ? await getAgentIdStatus(deps.publicClient, address)
      : await getAgentIdStatus(publicClient, address);

    res.json({
      agentAddress: address,
      network: "celo-mainnet",
      erc8004: selfStatus.registered
        ? { registered: true, agentId: selfStatus.agentId.toString() }
        : { registered: false, hint: selfStatus.hint },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Transaction status ────────────────────────────────────────────────────────

app.get("/tx/:hash", async (req: Request, res: Response) => {
  const h = req.params.hash;
  if (!isHash(h)) {
    res.status(400).json({ error: "invalid tx hash" });
    return;
  }
  if (!deps.publicClient) {
    res.status(503).json({ error: "RPC not configured", hint: "Set CELO_RPC_URL or RPC_URL" });
    return;
  }
  try {
    const out = await fetchTxReceiptStatus(deps.publicClient, h);
    res.json({
      ...out,
      message:
        out.status === "success"
          ? "Done ✅ Transaction succeeded."
          : out.status === "failed"
            ? "Failed ❌ Transaction reverted."
            : "Pending… No receipt yet.",
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/tx-status", async (req: Request, res: Response) => {
  const raw = req.body?.txHash ?? req.body?.hash;
  if (typeof raw !== "string" || !isHash(raw)) {
    res.status(400).json({ error: "txHash (0x-prefixed 32-byte hash) required" });
    return;
  }
  if (!deps.publicClient) {
    res.status(503).json({ error: "RPC not configured" });
    return;
  }
  try {
    const out = await fetchTxReceiptStatus(deps.publicClient, raw as `0x${string}`);
    res.json({
      ...out,
      message: out.status === "success" ? "Done ✅" : out.status === "failed" ? "Failed ❌" : "Pending…",
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── LI.FI cross-chain bridge ──────────────────────────────────────────────────

/**
 * GET /bridge/chains
 * Returns Celo as source (USDC/USDm) and destination chains (USDC only).
 */
app.get("/bridge/chains", (_req: Request, res: Response) => {
  res.json({
    source: getCeloBridgeSource(),
    destinations: getCeloOutboundDestinations(),
  });
});

/**
 * POST /bridge/quote  — Celo (USDC/USDm) → other chain (USDC)
 *
 * Body:
 *   fromChainId       — must be 42220 (Celo)
 *   fromTokenAddress  — token address on source chain
 *   fromAmount        — amount in base units as string  (e.g. "100000000")
 *   fromAddress       — sender wallet address
 *   toChainId         — destination chain ID  (e.g. 42220, 1, 8453)
 *   toTokenAddress    — token address on destination chain
 *   toAddress         — recipient wallet address
 *
 * Returns: { quoteId, tool, summary, transactionRequest, estimate }
 * The frontend signs transactionRequest on fromChainId, then polls /bridge/status.
 */
app.post("/bridge/quote", async (req: Request, res: Response) => {
  const {
    fromChainId,
    fromTokenAddress,
    fromAmount,
    fromAddress,
    toChainId,
    toTokenAddress,
    toAddress,
  } = req.body ?? {};

  if (!fromChainId || !fromTokenAddress || !fromAmount || !fromAddress ||
      !toChainId   || !toTokenAddress   || !toAddress) {
    res.status(400).json({
      error: "Required: fromChainId, fromTokenAddress, fromAmount, fromAddress, toChainId, toTokenAddress, toAddress",
      hint: "Call GET /bridge/chains for supported chain IDs and token addresses",
    });
    return;
  }

  try {
    const quote = await getBridgeQuote({
      fromChainId:      Number(fromChainId),
      fromTokenAddress: String(fromTokenAddress),
      fromAmount:       String(fromAmount),
      fromAddress:      fromAddress as `0x${string}`,
      toChainId:        Number(toChainId),
      toTokenAddress:   String(toTokenAddress),
      toAddress:        toAddress as `0x${string}`,
    });
    res.json({
      quoteId:            quote.id,
      tool:               quote.tool,
      summary:            formatBridgeSummary(quote),
      transactionRequest: quote.transactionRequest,
      estimate:           quote.estimate,
    });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /bridge/status?txHash=0x...&fromChainId=1&toChainId=42220
 * Poll after broadcasting the bridge tx.
 * Returns: { status: "PENDING" | "DONE" | "FAILED" | "NOT_FOUND", toTxHash?, receivedAmount? }
 */
app.get("/bridge/status", async (req: Request, res: Response) => {
  const txHash      = req.query.txHash      as string;
  const fromChainId = Number(req.query.fromChainId);
  const toChainId   = Number(req.query.toChainId);

  if (!txHash || !fromChainId || !toChainId) {
    res.status(400).json({ error: "Required query params: txHash, fromChainId, toChainId" });
    return;
  }

  try {
    const status = await getBridgeStatus(txHash, fromChainId, toChainId);
    res.json(status);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`Cowry agent  →  http://localhost:${port}  (resolution: ${deps.mode})`);
  try {
    const { address } = getAgentWallet();
    console.log(`Agent wallet →  ${address}`);
  } catch {
    console.warn(`Agent wallet →  (AGENT_PRIVATE_KEY not set — /agent/info unavailable)`);
  }
  console.log(`Agent info   →  GET http://localhost:${port}/agent/info`);
  console.log(`Chat         →  POST http://localhost:${port}/chat`);
});
