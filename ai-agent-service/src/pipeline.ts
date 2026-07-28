import { randomUUID } from "node:crypto";
import type { DraftRecord, DraftTxPlan, ParsedIntent } from "./schemas.js";
import { createGroqClient, generateChatReply } from "./llm.js";
import { encodeErc20Approve } from "./chain/encodeErc20.js";
import {
  encodeAddMember,
  encodeCancelGroup,
  encodeRemoveMember,
} from "./chain/encodeGroupRegistry.js";
import { readErc20Balance } from "./chain/erc20Reads.js";
import {
  encodePay,
  encodePayGroupEqual,
  encodePayGroupSplit,
  encodePayOnBehalf,
  encodePayGroupEqualOnBehalf,
  encodePayGroupSplitOnBehalf,
  encodedCallToJson,
} from "./chain/encodeCowryPay.js";
import { agentSendTx, tryGetAgentWallet } from "./agent/wallet.js";
import {
  checkUsdcReadiness,
  totalBaseUnitsFromTxPlan,
} from "./chain/usdcReadiness.js";
import {
  DEFAULT_TOKEN,
  getTokenBySymbol,
  getTokenByAddress,
  toBaseUnits,
  fromBaseUnits,
} from "./chain/tokenConfig.js";
import { resolvePaymentToken } from "./chain/paymentToken.js";
import type { PaymentTokenInfo } from "./chain/paymentToken.js";
import { getAgentIdentity } from "./agent/identity.js";
import {
  clearDraft,
  getPendingDraft,
  saveDraft,
  setPendingDraft,
  setEarnOpportunities,
  getEarnOpportunity,
  setPendingYieldDeposit,
  getPendingYieldDeposit,
} from "./state.js";
import type { ChatResponse, EncodedTxJson } from "./types.js";
import type { ResolutionDeps } from "./deps/types.js";
import {
  getOpportunities,
  getUserPositions,
  formatOpportunitiesList,
  formatApy,
} from "./lifi/earnClient.js";
import { getDepositQuote, estimateDailyEarnings } from "./lifi/composerClient.js";
import type { PendingYieldDeposit } from "./lifi/types.js";

function parseGroupId(
  raw: string | number | undefined | null,
): bigint | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function chainAdminGate(
  deps: ResolutionDeps,
  wallet: `0x${string}` | undefined,
): string | null {
  if (deps.mode !== "chain") {
    return "Group admin commands need **chain mode**. Set **CELO_RPC_URL** (or **RPC_URL**).";
  }
  if (!deps.publicClient) {
    return "No RPC client.";
  }
  if (!wallet) {
    return "Pass **walletAddress** (the wallet that will sign).";
  }
  return null;
}

function shortAddr(a: string): string {
  const x = a.toLowerCase();
  if (x.length < 12) return a;
  return `${x.slice(0, 6)}…${x.slice(-4)}`;
}

/** Split a total human amount into `count` equal shares (token-aware). Sums exactly. */
function splitEqualShares(
  totalHuman: number,
  count: number,
  decimals: number,
): { human: number; baseUnits: bigint }[] {
  const factor = 10 ** decimals;
  const totalBase = BigInt(Math.round(totalHuman * factor));
  const base = totalBase / BigInt(count);
  const rem = Number(totalBase - base * BigInt(count));
  return Array.from({ length: count }, (_, i) => {
    const units = base + BigInt(i < rem ? 1 : 0);
    return { human: Number(units) / factor, baseUnits: units };
  });
}

async function pickPaymentToken(
  intent: ParsedIntent & { kind: "payment" },
  deps: ResolutionDeps,
  wallet: `0x${string}` | undefined,
  amountHuman: number,
): Promise<
  | { ok: true; tokenInfo: PaymentTokenInfo; tokenAddress: `0x${string}`; tokenSymbol: string }
  | { ok: false; question: string }
> {
  const r = await resolvePaymentToken({
    explicitSymbol: intent.token,
    wallet,
    client: deps.publicClient,
    amountHuman,
  });
  if (r.clarify) return { ok: false, question: r.clarify };
  const tokenInfo = r.token!;
  return {
    ok: true,
    tokenInfo,
    tokenAddress: tokenInfo.address,
    tokenSymbol: tokenInfo.symbol,
  };
}

function buildPreviewLines(
  recipients: { username: string; amount: number }[],
  tokenSymbol: string,
): string {
  const lines = recipients.map(
    (r) => `• @${r.username}: ${r.amount.toLocaleString()} ${tokenSymbol}`,
  );
  const total = recipients.reduce((s, r) => s + r.amount, 0);
  return `${lines.join("\n")}\nTotal: ${total.toLocaleString()} ${tokenSymbol}`;
}

function policyCheck(
  recipients: { username: string; address: string; amount: number }[],
): string | null {
  const maxRecipients = 50;
  const maxPerTransfer = 1_000_000_000;
  if (recipients.length > maxRecipients) {
    return `Too many recipients (max ${maxRecipients})`;
  }
  for (const r of recipients) {
    if (r.amount <= 0) return "Amounts must be positive";
    if (r.amount > maxPerTransfer) {
      return `Amount exceeds maximum (${maxPerTransfer.toLocaleString()} per recipient)`;
    }
  }
  return null;
}

async function buildWelcomeMessage(
  deps: ResolutionDeps,
  wallet: `0x${string}` | undefined,
): Promise<string> {
  const lines: string[] = ["Welcome to **Cowry**."];
  if (deps.mode === "chain" && wallet && !(await deps.isWalletRegistered(wallet))) {
    lines.push(
      "",
      "**Your wallet does not have a Cowry name yet** — register before sending.",
    );
  }
  lines.push(
    "",
    "1. Always send **walletAddress** in the API body (the wallet that will sign).",
    "2. **Register**: **register as yourname** (3–32 chars, a–z and 0–9) — links your @name to your wallet on-chain.",
    "3. **Pay with USDC or USDm**: e.g. **send 20 USDC to @alice**, **send 5 USDm to @bob**, or **approve 500 USDC for cowry**.",
    "Say **help** for more.",
  );
  return lines.join("\n");
}

async function maybeTokenReadinessBlock(
  deps: ResolutionDeps,
  wallet: `0x${string}`,
  plan: DraftTxPlan,
): Promise<ChatResponse | null> {
  if (deps.mode !== "chain" || !deps.publicClient) return null;
  const meta = await deps.getMeta();
  const tokenAddr = plan.token as `0x${string}`;
  const tokenInfo = getTokenByAddress(tokenAddr);
  const required = totalBaseUnitsFromTxPlan(plan);
  const r = await checkUsdcReadiness(
    deps.publicClient,
    tokenAddr,
    wallet,
    meta.cowryPay,
    required,
  );
  if (r.ok) return null;

  const bal = fromBaseUnits(r.balance,  tokenInfo.decimals);
  const alw = fromBaseUnits(r.allowance, tokenInfo.decimals);
  const req = fromBaseUnits(r.required,  tokenInfo.decimals);
  const sym = tokenInfo.symbol;

  if (r.reason === "insufficient_balance") {
    return {
      type: "clarify",
      question: `Not enough ${sym}: this payment needs **${req} ${sym}** but your balance is **${bal} ${sym}**. Fund your wallet, then try again.`,
    };
  }

  const approveTx = encodedCallToJson(
    encodeErc20Approve(tokenAddr, meta.cowryPay, r.required),
  );
  return {
    type: "clarify",
    question: `CowryPay needs permission to pull **${req} ${sym}**; your ${sym} allowance for CowryPay is only **${alw} ${sym}**. Sign **approve** below, then send the same payment again and **confirm**.`,
    transactions: [approveTx],
    tokenSymbol: sym,
  };
}

/** Encode a plan for the USER to sign (fallback / direct path). */
function encodeTxPlan(plan: DraftTxPlan) {
  const token = plan.token as `0x${string}`;
  switch (plan.mode) {
    case "pay":
      return [
        encodedCallToJson(encodePay(token, plan.to as `0x${string}`, BigInt(plan.amountBaseUnits))),
      ];
    case "payGroupEqual":
      return [
        encodedCallToJson(encodePayGroupEqual(token, BigInt(plan.groupId), BigInt(plan.amountPerMemberBaseUnits))),
      ];
    case "payMany":
      return plan.items.map((i) =>
        encodedCallToJson(encodePay(token, i.to as `0x${string}`, BigInt(i.amountBaseUnits))),
      );
    case "payGroupSplit":
      return [
        encodedCallToJson(encodePayGroupSplit(token, BigInt(plan.groupId), BigInt(plan.totalBaseUnits))),
      ];
    default:
      throw new Error(`Unhandled plan mode: ${(plan as { mode: string }).mode}`);
  }
}

/**
 * Encode a plan for the AGENT to sign on behalf of `payer`.
 * Returns a single EncodedCall — agent broadcasts it directly.
 * For "payMany" (multiple recipients), agent sends one tx per recipient.
 */
function encodeTxPlanOnBehalf(
  plan: DraftTxPlan,
  payer: `0x${string}`,
): { to: `0x${string}`; data: `0x${string}`; value: `0x${string}` }[] {
  const token = plan.token as `0x${string}`;
  switch (plan.mode) {
    case "pay": {
      const c = encodePayOnBehalf(payer, token, plan.to as `0x${string}`, BigInt(plan.amountBaseUnits));
      return [{ to: c.to, data: c.data, value: c.value as `0x${string}` }];
    }
    case "payGroupEqual": {
      const c = encodePayGroupEqualOnBehalf(payer, token, BigInt(plan.groupId), BigInt(plan.amountPerMemberBaseUnits));
      return [{ to: c.to, data: c.data, value: c.value as `0x${string}` }];
    }
    case "payGroupSplit": {
      const c = encodePayGroupSplitOnBehalf(payer, token, BigInt(plan.groupId), BigInt(plan.totalBaseUnits));
      return [{ to: c.to, data: c.data, value: c.value as `0x${string}` }];
    }
    case "payMany":
      return plan.items.map((i) => {
        const c = encodePayOnBehalf(payer, token, i.to as `0x${string}`, BigInt(i.amountBaseUnits));
        return { to: c.to, data: c.data, value: c.value as `0x${string}` };
      });
    default:
      throw new Error(`Unhandled plan mode: ${(plan as { mode: string }).mode}`);
  }
}

export async function paymentFromIntent(
  intent: ParsedIntent,
  deps: ResolutionDeps,
  wallet: `0x${string}` | undefined,
): Promise<
  | { ok: true; draft: Omit<DraftRecord, "draftId" | "sessionId" | "createdAt"> }
  | { ok: false; question: string }
> {
  if (intent.kind !== "payment") {
    return { ok: false, question: "Not a payment command." };
  }

  if (intent.action === "SEND_SINGLE") {
    const amount = intent.amount;
    const handle = intent.recipient;
    if (amount == null || !handle) {
      return { ok: false, question: "I need an amount and a recipient like @tolu." };
    }
    const picked = await pickPaymentToken(intent, deps, wallet, amount);
    if (!picked.ok) return picked;
    const { tokenInfo, tokenAddress, tokenSymbol } = picked;

    const r = await deps.resolveUsername(handle);
    if (!r.ok) {
      return {
        ok: false,
        question: `Cannot resolve @${r.username}: ${r.reason ?? "unknown"}`,
      };
    }
    const base = toBaseUnits(amount, tokenInfo.decimals);
    const recipients = [
      { username: r.username, address: r.address, amount },
    ];
    const policy = policyCheck(recipients);
    if (policy) return { ok: false, question: policy };
    const preview = buildPreviewLines(recipients, tokenSymbol);
    const txPlan: DraftTxPlan = {
      mode: "pay",
      token: tokenAddress,
      to: r.address,
      amountHuman: amount,
      amountBaseUnits: base.toString(),
    };
    return {
      ok: true,
      draft: {
        action: "SEND_SINGLE",
        recipients,
        totalAmount: amount,
        preview,
        txPlan,
      },
    };
  }

  if (intent.action === "SEND_TO_GROUP") {
    const per = intent.perRecipientAmount;
    const gname = intent.groupName;
    if (per == null || !gname) {
      return {
        ok: false,
        question: "I need an amount per person and a group name.",
      };
    }
    const groupLabel = gname
      .trim()
      .toLowerCase()
      .replace(/\b(the|a|my)\b/g, "")
      .replace(/\bgroup\b/g, "")
      .trim();
    if (!groupLabel) {
      return {
        ok: false,
        question:
          "Which group should get paid? Example: **I want to send $100 to group Friends** (use your group’s name).",
      };
    }
    if (deps.mode === "chain" && !wallet) {
      return {
        ok: false,
        question:
          "Pass **walletAddress** (your wallet) in the API body so we can find groups you own or belong to.",
      };
    }
    const g = await deps.resolveGroupByName(gname, wallet);
    if (!g.ok) {
      return { ok: false, question: g.reason };
    }
    const totalForToken = per * g.members.length;
    const picked = await pickPaymentToken(intent, deps, wallet, totalForToken);
    if (!picked.ok) return picked;
    const { tokenInfo, tokenAddress, tokenSymbol } = picked;

    const perBase = toBaseUnits(per, tokenInfo.decimals);

    if (g.kind === "onchain") {
      const recipients = g.members.map((addr) => ({
        username: shortAddr(addr),
        address: addr,
        amount: per,
      }));
      const policy = policyCheck(recipients);
      if (policy) return { ok: false, question: policy };
      const preview = buildPreviewLines(recipients, tokenSymbol);
      const totalAmount = per * g.members.length;
      const txPlan: DraftTxPlan = {
        mode: "payGroupEqual",
        token: tokenAddress,
        groupId: g.groupId.toString(),
        amountPerMemberHuman: per,
        amountPerMemberBaseUnits: perBase.toString(),
        memberCount: g.members.length,
      };
      return {
        ok: true,
        draft: {
          action: "SEND_TO_GROUP",
          recipients,
          totalAmount,
          preview,
          txPlan,
        },
      };
    }

    const recipients = g.members.map((m) => ({
      username: m.username,
      address: m.address,
      amount: per,
    }));
    const policy = policyCheck(recipients);
    if (policy) return { ok: false, question: policy };
    const preview = buildPreviewLines(recipients, tokenSymbol);
    const items = recipients.map((r) => ({
      to: r.address,
      amountHuman: per,
      amountBaseUnits: perBase.toString(),
    }));
    const txPlan: DraftTxPlan = { mode: "payMany", token: tokenAddress, items };
    const totalAmount = per * recipients.length;
    return {
      ok: true,
      draft: {
        action: "SEND_TO_GROUP",
        recipients,
        totalAmount,
        preview,
        txPlan,
      },
    };
  }

  if (intent.action === "GROUP_SPLIT_TOTAL") {
    const total = intent.amount;
    const gname = intent.groupName;
    if (total == null || !gname) {
      return {
        ok: false,
        question:
          "I need a **total** amount and a group, e.g. **split 100 USDC across group Friends** or **split 50 USDm in Friends group**.",
      };
    }
    const groupLabel = gname
      .trim()
      .toLowerCase()
      .replace(/\b(the|a|my)\b/g, "")
      .replace(/\bgroup\b/g, "")
      .trim();
    if (!groupLabel) {
      return {
        ok: false,
        question:
          "Which group? Example: **split $90 across group Team** (include the group name).",
      };
    }
    if (deps.mode === "chain" && !wallet) {
      return {
        ok: false,
        question:
          "Pass **walletAddress** so we can resolve the group on-chain.",
      };
    }
    const g = await deps.resolveGroupByName(gname, wallet);
    if (!g.ok) {
      return { ok: false, question: g.reason };
    }
    const picked = await pickPaymentToken(intent, deps, wallet, total);
    if (!picked.ok) return picked;
    const { tokenInfo, tokenAddress, tokenSymbol } = picked;

    const totalBase = toBaseUnits(total, tokenInfo.decimals);
    const n = g.members.length;
    const shares = splitEqualShares(total, n, tokenInfo.decimals);
    const recipients =
      g.kind === "onchain"
        ? g.members.map((addr, i) => ({
            username: shortAddr(addr),
            address: addr,
            amount: shares[i]!.human,
          }))
        : g.members.map((m, i) => ({
            username: m.username,
            address: m.address,
            amount: shares[i]!.human,
          }));
    const policy = policyCheck(recipients);
    if (policy) return { ok: false, question: policy };
    const preview = `${buildPreviewLines(recipients, tokenSymbol)}\n(One **payGroupSplit** tx on-chain; preview shows an even micro-split for display.)`;

    if (g.kind === "onchain") {
      const txPlan: DraftTxPlan = {
        mode: "payGroupSplit",
        token: tokenAddress,
        groupId: g.groupId.toString(),
        totalHuman: total,
        totalBaseUnits: totalBase.toString(),
        memberCount: n,
      };
      return {
        ok: true,
        draft: {
          action: "GROUP_SPLIT_TOTAL",
          recipients,
          totalAmount: total,
          preview,
          txPlan,
        },
      };
    }

    const items = recipients.map((r, i) => ({
      to: r.address as `0x${string}`,
      amountHuman: shares[i]!.human,
      amountBaseUnits: shares[i]!.baseUnits.toString(),
    }));
    return {
      ok: true,
      draft: {
        action: "GROUP_SPLIT_TOTAL",
        recipients,
        totalAmount: total,
        preview,
        txPlan: { mode: "payMany", token: tokenAddress, items },
      },
    };
  }

  if (intent.action === "SPLIT_EQUAL") {
    const total = intent.amount;
    const members = intent.members;
    const splitCount = intent.splitCount;
    if (total == null) {
      return { ok: false, question: "I need a total amount to split." };
    }
    if (!members || members.length < 2) {
      if (splitCount != null && splitCount >= 2) {
        return {
          ok: false,
          question: `Split among ${splitCount} people — who should receive? Tag them: @ada @tolu …`,
        };
      }
      return {
        ok: false,
        question:
          "Name at least two recipients with @username, or say how many people and who they are.",
      };
    }
    const resolved: { username: string; address: `0x${string}` }[] = [];
    for (const h of members) {
      const r = await deps.resolveUsername(h);
      if (!r.ok) {
        return {
          ok: false,
          question: `Cannot resolve @${r.username}: ${r.reason ?? "unknown"}`,
        };
      }
      resolved.push({ username: r.username, address: r.address });
    }
    const picked = await pickPaymentToken(intent, deps, wallet, total);
    if (!picked.ok) return picked;
    const { tokenInfo, tokenAddress, tokenSymbol } = picked;

    const shares = splitEqualShares(total, resolved.length, tokenInfo.decimals);
    const recipients = resolved.map((r, i) => ({
      username: r.username,
      address: r.address,
      amount: shares[i]!.human,
    }));
    const policy = policyCheck(recipients);
    if (policy) return { ok: false, question: policy };
    const preview = buildPreviewLines(recipients, tokenSymbol);
    const items = resolved.map((r, i) => ({
      to: r.address,
      amountHuman: shares[i]!.human,
      amountBaseUnits: shares[i]!.baseUnits.toString(),
    }));
    const txPlan: DraftTxPlan = { mode: "payMany", token: tokenAddress, items };
    return {
      ok: true,
      draft: {
        action: "SPLIT_EQUAL",
        recipients,
        totalAmount: total,
        preview,
        txPlan,
      },
    };
  }

  return { ok: false, question: "Unsupported payment action." };
}

type AdminIntentResult =
  | { kind: "info"; message: string; transactions?: EncodedTxJson[] }
  | { kind: "clarify"; question: string };

export async function adminFromIntent(
  intent: ParsedIntent,
  deps: ResolutionDeps,
  wallet: `0x${string}` | undefined,
  rawText?: string,
): Promise<AdminIntentResult> {
  if (intent.kind !== "admin") {
    return { kind: "clarify", question: "Not an admin command." };
  }
  if (intent.action === "REGISTER_USERNAME") {
    const name = intent.username?.trim();
    if (!name) {
      return {
        kind: "clarify",
        question:
          "Say **register as yourname** (3–32 characters: lowercase letters and numbers only).",
      };
    }
    const res = await deps.adminRegisterUsername(name, wallet);
    if (!res.ok) {
      return { kind: "clarify", question: res.reason };
    }
    return {
      kind: "info",
      message: res.message,
      transactions: res.transactions,
    };
  }
  if (intent.action === "APPROVE_USDC") {
    const amt = intent.amount;
    if (amt == null || !Number.isFinite(amt)) {
      return {
        kind: "clarify",
        question:
          "Say how much USDC to approve, e.g. **approve 500 usdc for cowry** or **approve cowry to spend 50**.",
      };
    }
    if (deps.mode !== "chain") {
      return {
        kind: "info",
        message:
          "Mock mode has no USDm/USDC on-chain. With **CELO_RPC_URL** set, **approve 500 usdm for cowry** returns **USDm.approve(CowryPay, …)** calldata.",
      };
    }
    if (!wallet) {
      return {
        kind: "clarify",
        question:
          "Pass **walletAddress** (the wallet that will sign the approve transaction).",
      };
    }
    const meta = await deps.getMeta();
    const approveToken = intent.token ? getTokenBySymbol(intent.token) : DEFAULT_TOKEN;
    const base = toBaseUnits(amt, approveToken.decimals);
    const tx = encodeErc20Approve(approveToken.address, meta.cowryPay, base);
    return {
      kind: "info",
      message: `Sign **${approveToken.symbol}.approve** so CowryPay can pull up to **${amt} ${approveToken.symbol}** (approve more if you plan several payments).`,
      transactions: [encodedCallToJson(tx)],
    };
  }
  if (intent.action === "ADD_MEMBERS") {
    const gate = chainAdminGate(deps, wallet);
    if (gate) return { kind: "clarify", question: gate };
    const gid = parseGroupId(intent.groupId);
    if (gid == null) {
      return {
        kind: "clarify",
        question:
          "Say which group id, e.g. **add @mack to group 3** (get ids from **list my groups**).",
      };
    }
    const handles = intent.members ?? [];
    if (handles.length === 0) {
      return {
        kind: "clarify",
        question: "Name who to add, e.g. **add @mack to group 3**.",
      };
    }
    const txs: EncodedTxJson[] = [];
    for (const h of handles) {
      const r = await deps.resolveUsername(h);
      if (!r.ok) {
        return {
          kind: "clarify",
          question: `Cannot resolve @${r.username}: ${r.reason ?? "unknown"}`,
        };
      }
      txs.push(
        encodedCallToJson(encodeAddMember(gid, r.address)),
      );
    }
    return {
      kind: "info",
      message: `Sign **${txs.length}** GroupRegistry.addMember tx(s) for group **${gid}**. Only the group **owner** can add members.`,
      transactions: txs,
    };
  }
  if (intent.action === "REMOVE_MEMBERS") {
    const gate = chainAdminGate(deps, wallet);
    if (gate) return { kind: "clarify", question: gate };
    const gid = parseGroupId(intent.groupId);
    if (gid == null) {
      return {
        kind: "clarify",
        question:
          "Say which group id, e.g. **remove @mack from group 3**.",
      };
    }
    const handles = intent.members ?? [];
    if (handles.length === 0) {
      return {
        kind: "clarify",
        question: "Name who to remove, e.g. **remove @mack from group 3**.",
      };
    }
    const txs: EncodedTxJson[] = [];
    for (const h of handles) {
      const r = await deps.resolveUsername(h);
      if (!r.ok) {
        return {
          kind: "clarify",
          question: `Cannot resolve @${r.username}: ${r.reason ?? "unknown"}`,
        };
      }
      txs.push(
        encodedCallToJson(encodeRemoveMember(gid, r.address)),
      );
    }
    return {
      kind: "info",
      message: `Sign **${txs.length}** GroupRegistry.removeMember tx(s) for group **${gid}**. Only the group **owner** can remove members.`,
      transactions: txs,
    };
  }
  if (intent.action === "CANCEL_GROUP") {
    const gate = chainAdminGate(deps, wallet);
    if (gate) return { kind: "clarify", question: gate };
    const gid = parseGroupId(intent.groupId);
    if (gid == null) {
      return {
        kind: "clarify",
        question: "Say which group id, e.g. **cancel group 3**.",
      };
    }
    const tx = encodeCancelGroup(gid);
    return {
      kind: "info",
      message: `Sign **cancelGroup** for id **${gid}** (owner only). Future group pays will be blocked.`,
      transactions: [encodedCallToJson(tx)],
    };
  }
  if (intent.action === "LIST_GROUPS") {
    if (deps.mode === "chain" && !wallet) {
      return {
        kind: "clarify",
        question:
          "Pass **walletAddress** in the request body to list on-chain groups.",
      };
    }
    const message = await deps.listGroups(wallet);
    return { kind: "info", message };
  }
  if (intent.action === "HELP") {
    return {
      kind: "info",
      message: [
        "Cowry — **USDC** & **USDm** payments via CowryPay on Celo:",
        "• **register as yourname** — links @name to your wallet (sign UsernameRegistry.register)",
        "• **approve 500 USDC for cowry** or **approve 500 USDm for cowry**",
        "• **send 20 USDC to @alice** or **send 5 USDm to @bob**",
        "• **send 10 USDC to everyone in Friends** — same amount per group member",
        "• **split 30 USDC among @alice, @bob, @carol**",
        "• **split 100 USDm across group Friends** — total split (**payGroupSplit**)",
        "• **add @mack to group 3** / **remove @mack from group 3** / **cancel group 3** (chain only; owner-only)",
        "• create group Team with @alice, @bob",
        "• list my groups",
        "• **GET /tx/0x…** — receipt status after you broadcast",
        "On-chain: pass **walletAddress**; register before paying; balance + allowance checked.",
        "After a payment draft: **confirm** or **cancel**.",
      ].join("\n"),
    };
  }
  if (intent.action === "CREATE_GROUP") {
    const name = intent.groupName;
    const mem = intent.members ?? [];
    if (!name || mem.length === 0) {
      return {
        kind: "clarify",
        question: "Say: create group MyName with @user1, @user2",
      };
    }
    const res = await deps.adminCreateGroup(name, mem);
    if (!res.ok) {
      return { kind: "clarify", question: res.reason };
    }
    return {
      kind: "info",
      message: res.message,
      transactions: res.transactions,
    };
  }
  if (intent.action === "BALANCE") {
    if (!wallet) {
      return {
        kind: "info",
        message: "Pass **walletAddress** in the request to check your balance.",
      };
    }
    if (deps.mode !== "chain" || !deps.publicClient) {
      return { kind: "info", message: "Balance check requires an RPC connection (mock mode)." };
    }
    try {
      const USDM  = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as `0x${string}`;
      const USDC  = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as `0x${string}`;
      const [usdmRaw, usdcRaw] = await Promise.all([
        readErc20Balance(deps.publicClient, USDM, wallet),
        readErc20Balance(deps.publicClient, USDC, wallet),
      ]);
      const usdm = (Number(usdmRaw) / 1e18).toFixed(4);
      const usdc = (Number(usdcRaw) / 1e6).toFixed(4);
      return {
        kind: "info",
        message:
          `💳 **Balance for ${wallet.slice(0, 6)}…${wallet.slice(-4)}**\n\n` +
          `• **USDm:** ${Number(usdm).toLocaleString()} USDm\n` +
          `• **USDC:** ${Number(usdc).toLocaleString()} USDC\n\n` +
          `_Network: Celo Mainnet_`,
      };
    } catch (e) {
      return {
        kind: "clarify",
        question: `Could not fetch balance: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (intent.action === "CHAT") {
    // General conversational message — use LLM to reply naturally
    const llm = createGroqClient();
    if (llm) {
      try {
        const reply = await generateChatReply(llm, rawText ?? "Hello");
        return { kind: "info", message: reply };
      } catch {
        // fall through to default
      }
    }
    return {
      kind: "info",
      message:
        "Hi! I'm Cowry — your AI payment assistant on Celo.\n\nTry: **send 10 USDm to @alice**, **list my groups**, **my balance**, or say **help** for all commands.",
    };
  }

  return { kind: "clarify", question: "Unknown admin command." };
}

// ── LI.FI Earn handler ───────────────────────────────────────────────────────────────

export async function earnFromIntent(
  intent: ParsedIntent,
  sessionId: string,
  walletAddress: `0x${string}` | undefined,
): Promise<ChatResponse> {
  if (intent.kind !== "earn") {
    return { type: "clarify", question: "Not an earn command." };
  }

  // ── LIST_OPPORTUNITIES ────────────────────────────────────────────────────
  if (intent.action === "LIST_OPPORTUNITIES") {
    let opps;
    try {
      opps = await getOpportunities({
        tokenSymbol: "USDC",
        chainName: intent.chainName,
        minApy: intent.minApy,
        limit: 5,
      });
    } catch (e) {
      return {
        type: "info",
        message: `⚠️ Could not fetch yield vaults right now: ${
          e instanceof Error ? e.message : String(e)
        }. Try again in a moment.`,
      };
    }
    setEarnOpportunities(sessionId, opps);
    const list = formatOpportunitiesList(opps);
    return {
      type: "info",
      message:
        `*🏦 Top USDC Yield Vaults (via LI.FI)*\n\n${list}\n\n` +
        `Reply with a number and amount to deposit, e.g.\n` +
        `*deposit 0.1 USDC into vault 1* or *1 with 0.05 USDC*`,
    };
  }

  // ── DEPOSIT_YIELD ───────────────────────────────────────────────────────────
  if (intent.action === "DEPOSIT_YIELD") {
    if (!walletAddress) {
      return {
        type: "clarify",
        question: "Pass **walletAddress** so we can build your deposit transaction.",
      };
    }
    const amount = intent.amount;
    if (!amount || amount <= 0) {
      return {
        type: "clarify",
        question: "How much USDC would you like to deposit? e.g. *deposit 0.1 USDC into vault 1*",
      };
    }
    if (amount < 0.02) {
      return {
        type: "clarify",
        question: `Minimum deposit is **0.02 USDC** (balances visible from 0.02 USDC on Morpho). You entered ${amount} USDC.`,
      };
    }

    // Get the selected vault (or default to vault 1 = Morpho)
    const opp = getEarnOpportunity(sessionId, intent.vaultIndex ?? 1);
    if (!opp) {
      // No opportunities list in session — fetch first
      try {
        const opps = await getOpportunities({ tokenSymbol: "USDC", limit: 5 });
        setEarnOpportunities(sessionId, opps);
      } catch {
        return {
          type: "clarify",
          question: "Say *earn yield on my USDC* first to see the vault list, then pick one.",
        };
      }
    }
    const vault = getEarnOpportunity(sessionId, intent.vaultIndex ?? 1);
    if (!vault) {
      return {
        type: "clarify",
        question: "Could not find that vault. Say *earn yield* to see the current list.",
      };
    }

    // Build deposit tx via LI.FI Composer
    let quote;
    try {
      quote = await getDepositQuote({
        opportunityId: vault.id,
        fromChainId: vault.chainId,
        fromTokenAddress: vault.tokenAddress,
        fromAmount: toBaseUnits(amount, vault.tokenDecimals).toString(),
        fromAddress:walletAddress,
        toTokenAddress: vault.vaultAddress,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        type: "clarify",
        question: `Could not build deposit quote: ${msg.slice(0, 200)}. Check that you have enough USDC on Base and try again.`,
      };
    }

    const tx = quote.transactionRequest;
    const daily = estimateDailyEarnings(amount, vault.apy);
    const yearly = estimateDailyEarnings(amount * 365, vault.apy);

    // Store pending for confirm
    const deposit: PendingYieldDeposit = {
      step: "AWAIT_YIELD_CONFIRM",
      opportunity: vault,
      amountHuman: amount,
      txTo:       tx.to,
      txData:     tx.data,
      txValue:    tx.value,
      txChainId:  tx.chainId,
      txGasLimit: tx.gasLimit,
      txGasPrice: tx.gasPrice,
      createdAt:  Date.now(),
    };
    setPendingYieldDeposit(sessionId, deposit);

    return {
      type: "info",
      message:
        `*🏦 Yield Deposit Preview*\n\n` +
        `• Vault: *${vault.protocol} Gauntlet USDC Prime*\n` +
        `• Network: *${vault.chainName}* (Chain ID: ${vault.chainId})\n` +
        `• Amount: *${amount} USDC*\n` +
        `• APY: *${formatApy(vault.apy)}*\n` +
        `• Daily earnings: *${daily}*\n` +
        `• Yearly earnings: *${yearly.replace("~$", "~$")}*\n\n` +
        `Type *confirm* to sign and broadcast, or *cancel* to abort.`,
    };
  }

  // ── VIEW_POSITIONS ───────────────────────────────────────────────────────────
  if (intent.action === "VIEW_POSITIONS") {
    if (!walletAddress) {
      return {
        type: "clarify",
        question: "Pass **walletAddress** so I can check your yield positions.",
      };
    }
    let positions;
    try {
      positions = await getUserPositions(walletAddress);
    } catch (e) {
      return {
        type: "info",
        message: `⚠️ Could not fetch positions: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (positions.length === 0) {
      return {
        type: "info",
        message:
          `No active yield positions found for ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}.\n` +
          `Say *earn yield on my USDC* to see available vaults and make a deposit.`,
      };
    }
    const NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
    const lines = positions.map((p, i) => {
      const num = NUMS[i] ?? `${i + 1}.`;
      return (
        `${num} *${p.protocol ?? "Unknown"}* on ${p.chainName ?? "??"}\n` +
        `   Balance: *$${p.balanceUsd.toFixed(4)} USDC*` +
        (p.apy ? ` | APY: *${formatApy(p.apy)}*` : "")
      );
    });
    const total = positions.reduce((s, p) => s + (p.balanceUsd ?? 0), 0);
    return {
      type: "info",
      message:
        `*📈 Your Yield Positions*\n\n${lines.join("\n\n")}\n\n` +
        `Total: *$${total.toFixed(4)} USDC*\n` +
        `View on Morpho: https://app.morpho.org/base/vault/0x050cE30b927Da55177A4914EC73480238BAD56f0/gauntlet-usdc-prime`,
    };
  }

  return { type: "clarify", question: "Unknown earn command." };
}

const CONFIRM_RE = /^(yes|y|confirm|ok|proceed|sure)\b/i;
const CANCEL_RE = /^(no|cancel|stop|nope)\b/i;

export type ParseMessageFn = (text: string) => Promise<ParsedIntent>;

export async function handleUserMessage(
  sessionId: string,
  message: string,
  deps: ResolutionDeps,
  parseFn: ParseMessageFn,
  walletAddress?: `0x${string}`,
): Promise<ChatResponse> {
  const t = message.trim();

  if (CONFIRM_RE.test(t)) {
    // ── Check yield deposit confirmation first ────────────────────────────
    const pendingYield = getPendingYieldDeposit(sessionId);
    if (pendingYield) {
      setPendingYieldDeposit(sessionId, null);
      const earnTx: EncodedTxJson = {
        to: pendingYield.txTo,
        data: pendingYield.txData,
        value: pendingYield.txValue,
        description: `Deposit ${pendingYield.amountHuman} USDC into ${pendingYield.opportunity.protocol} on ${pendingYield.opportunity.chainName}`,
      };
      return {
        type: "earn_draft",
        preview:
          `Deposit ${pendingYield.amountHuman} USDC into ` +
          `${pendingYield.opportunity.protocol} (${pendingYield.opportunity.chainName}) ` +
          `at ${formatApy(pendingYield.opportunity.apy)} APY`,
        transactions: [earnTx],
      };
    }

    // ── Existing payment draft confirmation ─────────────────────────────
    const pending = getPendingDraft(sessionId);
    if (!pending) {
      return {
        type: "info",
        message: "Nothing to confirm. Try a payment command first.",
      };
    }
    if (deps.mode === "chain") {
      if (!walletAddress) {
        return {
          type: "clarify",
          question:
            "Pass **walletAddress** in the request body to confirm (must match a registered Cowry wallet).",
        };
      }
      if (!(await deps.isWalletRegistered(walletAddress))) {
        return {
          type: "clarify",
          question:
            "This wallet is not registered yet. Say **register as yourname**, sign the tx, then confirm again.",
        };
      }
      if (deps.publicClient) {
        const block = await maybeTokenReadinessBlock(
          deps,
          walletAddress,
          pending.txPlan,
        );
        if (block) return block;
      }
    }
    setPendingDraft(sessionId, null);
    clearDraft(pending.draftId);

    // ── Agent-executed path ────────────────────────────────────────────────
    // The Cowry AI agent signs and broadcasts the tx directly.
    // Funds flow: payer (user, pre-approved CowryPay) → recipients.
    // All tx volume is on the agent's address — agent is the on-chain actor.
    const agentWallet = tryGetAgentWallet();
    if (agentWallet && walletAddress && deps.mode === "chain") {
      try {
        const calls = encodeTxPlanOnBehalf(pending.txPlan, walletAddress);
        // For payMany we send sequential txs; all others are a single call.
        let lastHash: `0x${string}` = "0x";
        for (const call of calls) {
          lastHash = await agentSendTx(call.to, call.data, 0n);
        }
        const explorerUrl = `https://celoscan.io/tx/${lastHash}`;
        return {
          type: "tx_sent",
          preview: pending.preview,
          txHash: lastHash,
          explorerUrl,
          agentAddress: agentWallet.address,
        };
      } catch (err) {
        // If agent execution fails, fall back to returning calldata for the user to sign.
        // This handles cases like missing CELO gas on agent wallet gracefully.
        const errMsg = err instanceof Error ? err.message : String(err);
        const meta = await deps.getMeta();
        const tokenInfo = getTokenByAddress(pending.txPlan.token);
        const transactions = encodeTxPlan(pending.txPlan);
        const agent = await getAgentIdentity(deps.publicClient);
        return {
          type: "tx_ready",
          draftId: pending.draftId,
          preview: pending.preview,
          tx: {
            chainId: meta.chainId,
            token: { address: tokenInfo.address, symbol: tokenInfo.symbol, decimals: tokenInfo.decimals },
            cowryPay: meta.cowryPay,
            note: `⚠️ Agent execution failed (${errMsg}). Please sign manually.`,
            transactions,
          },
          ...(agent ? { agent } : {}),
        };
      }
    }

    // ── Fallback: no agent wallet configured → return calldata for user to sign ──
    const meta = await deps.getMeta();
    const tokenInfo = getTokenByAddress(pending.txPlan.token);
    const transactions = encodeTxPlan(pending.txPlan);
    const agent = await getAgentIdentity(deps.publicClient);
    return {
      type: "tx_ready",
      draftId: pending.draftId,
      preview: pending.preview,
      tx: {
        chainId: meta.chainId,
        token: { address: tokenInfo.address, symbol: tokenInfo.symbol, decimals: tokenInfo.decimals },
        cowryPay: meta.cowryPay,
        note:
          "AGENT_PRIVATE_KEY not set. You are signing with your MiniPay wallet.",
        transactions,
      },
      ...(agent ? { agent } : {}),
    };
  }

  if (CANCEL_RE.test(t)) {
    // Clear yield deposit if pending
    const pendingYield = getPendingYieldDeposit(sessionId);
    if (pendingYield) {
      setPendingYieldDeposit(sessionId, null);
      return { type: "cancelled", message: "Yield deposit cancelled. What next?" };
    }
    const pending = getPendingDraft(sessionId);
    if (pending) {
      clearDraft(pending.draftId);
      setPendingDraft(sessionId, null);
      return { type: "cancelled", message: "Draft cancelled. What next?" };
    }
    return { type: "info", message: "No active draft. Say **help** for examples." };
  }

  const intent = await parseFn(t);

  if (intent.kind === "unknown") {
    // Try conversational LLM reply before showing the fallback error
    const llm = createGroqClient();
    if (llm) {
      try {
        const reply = await generateChatReply(llm, t);
        return { type: "info", message: reply };
      } catch { /* fall through */ }
    }
    return {
      type: "clarify",
      question:
        "I didn't quite get that. Try **send $20 to @alice**, **list my groups**, **my balance**, or say **help** for all commands.",
    };
  }

  if (intent.kind === "admin") {
    const a = await adminFromIntent(intent, deps, walletAddress, t);
    if (a.kind === "clarify") {
      return { type: "clarify", question: a.question };
    }
    return {
      type: "info",
      message: a.message,
      ...(a.transactions?.length ? { transactions: a.transactions } : {}),
    };
  }

  // ── LI.FI Earn intents ─────────────────────────────────────────────────────
  if (intent.kind === "earn") {
    return earnFromIntent(intent, sessionId, walletAddress);
  }

  if (intent.kind === "payment") {
    if (deps.mode === "chain") {
      if (!walletAddress) {
        return {
          type: "clarify",
          question:
            "Include **walletAddress** in the JSON body. We use it to confirm your wallet is registered with a Cowry name before sending, and to find your groups.",
        };
      }
      if (!(await deps.isWalletRegistered(walletAddress))) {
        return {
          type: "clarify",
          question:
            "Link your wallet to a Cowry name first: say **register as yourname** (3–32 chars, a–z and 0–9), sign the UsernameRegistry transaction, then try paying again.",
        };
      }
    }
  }

  const p = await paymentFromIntent(intent, deps, walletAddress);
  if (!p.ok) return { type: "clarify", question: p.question };

  if (deps.mode === "chain" && deps.publicClient && walletAddress) {
    const block = await maybeTokenReadinessBlock(
      deps,
      walletAddress,
      p.draft.txPlan,
    );
    if (block) return block;
  }

  const draftId = randomUUID();
  const draft: DraftRecord = {
    draftId,
    sessionId,
    createdAt: Date.now(),
    ...p.draft,
  };
  saveDraft(draft);
  setPendingDraft(sessionId, draftId);

  const draftToken = getTokenByAddress(p.draft.txPlan.token);

  return {
    type: "draft",
    draftId,
    preview: draft.preview,
    action: draft.action,
    recipients: draft.recipients,
    totalAmount: draft.totalAmount,
    tokenSymbol: draftToken.symbol,
  };
}
