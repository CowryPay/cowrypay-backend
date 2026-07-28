/**
 * AI intent parser for the WhatsApp webhook flow.
 *
 * Uses the Groq LLM (OpenAI-compatible API) to classify and extract
 * structured Intent objects from free-form WhatsApp messages.
 *
 * Falls back to deterministic rule matching for the most common patterns
 * before calling the LLM, keeping latency low for frequent messages.
 */
import OpenAI from "openai";
import type { Intent } from "../types.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const SYSTEM = `You are a WhatsApp payment assistant intent parser for an app called CowryPay on Monad.
Output ONLY valid JSON matching exactly one of these shapes (no markdown, no extra keys):

Payment:
  Send to one person:  {"action":"SEND_SINGLE","totalAmount":<number>,"recipient":"<username_no_at>","note":"<optional>"}
  Split among people:  {"action":"SPLIT_PAYMENT","totalAmount":<number>,"recipients":["<user1>","<user2>"],"note":"<optional>"}
  Pay a group:         {"action":"GROUP_PAYMENT","totalAmount":<number>,"groupName":"<name>"}
  Split among N (unknown names): {"action":"SPLIT_COUNT","totalAmount":<number>,"count":<N>}

Info:
  Check balance:   {"action":"BALANCE"}
  Tx history:      {"action":"TX_HISTORY"}
  Help:            {"action":"HELP"}

Group management:
  Create group:       {"action":"CREATE_GROUP","name":"<group name>","members":["<user1>","<user2>"]}
  Add to group:       {"action":"ADD_TO_GROUP","groupName":"<name>","member":"<username_no_at>"}
  Remove from group:  {"action":"REMOVE_FROM_GROUP","groupName":"<name>","member":"<username_no_at>"}
  List groups:        {"action":"LIST_GROUPS"}

Yield / Earn (LI.FI):
  Find vaults:     {"action":"FIND_YIELD","minApy":<number_or_null>,"yieldChain":"<chain_or_null>","yieldToken":"USDC"}
  Deposit:         {"action":"DEPOSIT_YIELD","totalAmount":<number>,"vaultIndex":<1_based_int_or_null>}
  My positions:    {"action":"CHECK_POSITIONS"}

Rules:
- Strip "@" from usernames in the JSON output.
- Usernames are lowercase letters, numbers, underscores only.
- All amounts are in USDC (e.g. "$20 USDC", "20 USDC", "20" all mean 20 USDC).
- "k" suffix means × 1000: "2k" = 2000, "10k" = 10000.
- For FIND_YIELD: minApy is a percent number (e.g. "above 5%" → 5). yieldChain is the chain name if mentioned ("Arbitrum", "Base", etc.), otherwise null.
- For DEPOSIT_YIELD: vaultIndex is the vault number the user picked (e.g. "vault 1" → 1, "the top one" → 1, "second one" → 2). null if not specified.
- If the message is unclear or unrelated, return: {"action":"HELP"}`;

// ── Rule-based fast path ──────────────────────────────────────────────────────

function parseMoneyAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").toLowerCase();
  const kMatch = cleaned.match(/^([\d.]+)k$/);
  if (kMatch) return parseFloat(kMatch[1]!) * 1000;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractUsernames(text: string): string[] {
  const STOP = new Set([
    "to", "in", "with", "group", "everyone", "among", "between",
    "split", "send", "people", "want", "the", "my", "and", "for",
  ]);
  return [...text.matchAll(/@?([a-z0-9_]{2,})/gi)]
    .map((m) => m[1]!.toLowerCase())
    .filter((w) => !STOP.has(w));
}

function ruleParse(text: string): Intent | null {
  const lower = text.trim().toLowerCase();

  if (/^(my\s+)?balance\b/.test(lower) || /\bcheck\s+balance\b/.test(lower))
    return { action: "BALANCE" };

  if (/\b(my\s+)?transactions?\b/.test(lower) || /\btx\s+history\b/.test(lower))
    return { action: "TX_HISTORY" };

  if (/\b(my\s+)?groups\b/.test(lower) || /^list\s+groups\b/.test(lower))
    return { action: "LIST_GROUPS" };

  if (lower === "help" || lower === "help me")
    return { action: "HELP" };

  // ── Yield / Earn intents (LI.FI) ────────────────────────────────────────

  // "my positions" / "my yield" / "what am I earning" / "show my earnings"
  if (
    /\bmy\s+(yield|positions?|earnings?|vaults?|deposits?)\b/.test(lower) ||
    /\bwhat\s+am\s+i\s+earn/i.test(lower) ||
    /\bshow\s+(my\s+)?(yield|positions?|earnings?)\b/.test(lower)
  ) {
    return { action: "CHECK_POSITIONS" };
  }

  // "find yield" / "show me vaults" / "best APY" / "USDC vaults" / "earn on USDC"
  const findYield =
    lower.match(/(?:find|show|get|list)\s+(?:me\s+)?(?:(?:usdc\s+)?yield|(?:usdc\s+)?vaults?|(?:best\s+)?apy)/i) ||
    lower.match(/\b(?:best|top|highest)\s+(?:apy|yield|rates?|vaults?)\b/i) ||
    lower.match(/\bearn\s+(?:on\s+)?usdc\b/i) ||
    lower.match(/\busdc\s+yield\b/i);
  if (findYield) {
    // Try to extract "above X%" or "at least X%"
    const apyMatch = lower.match(/(?:above|over|at\s+least|minimum|min)\s+([\d.]+)\s*%/);
    const minApy   = apyMatch ? parseFloat(apyMatch[1]!) : undefined;
    // Try to extract a chain name
    const chainMatch = lower.match(/\bon\s+(arbitrum|base|ethereum|optimism|polygon|avalanche|bsc|linea|scroll)\b/i);
    const yieldChain = chainMatch ? chainMatch[1] : undefined;
    return { action: "FIND_YIELD", minApy, yieldChain, yieldToken: "USDC" };
  }

  // "deposit $100 into vault 1" / "put $200 in the top vault" / "invest $50 in vault 2"
  const depositYield = lower.match(
    /(?:deposit|put|invest|earn\s+with|place)\s+[$]?\s*([\d,.]+k?)\s+(?:usdc\s+)?(?:in(?:to)?|on)\s+(?:vault\s+(\d+)|the\s+(?:top|first|best)|(?:vault\s+)?(\d+))/,
  );
  if (depositYield) {
    const amount = parseMoneyAmount(depositYield[1]!);
    const idxRaw = depositYield[2] ?? depositYield[3];
    if (amount) {
      return {
        action:     "DEPOSIT_YIELD",
        totalAmount: amount,
        vaultIndex:  idxRaw ? parseInt(idxRaw) : 1,
      };
    }
  }

  // "deposit $100" (no vault specified — default to vault 1 if list exists)
  const depositSimple = lower.match(/(?:deposit|invest)\s+[$]?\s*([\d,.]+k?)\s*(?:usdc)?$/);
  if (depositSimple) {
    const amount = parseMoneyAmount(depositSimple[1]!);
    if (amount) {
      return { action: "DEPOSIT_YIELD", totalAmount: amount, vaultIndex: 1 };
    }
  }

  // "create group <name> with @u1 @u2"
  const create = lower.match(/create\s+group\s+['"]?([^'"]+?)['"]?\s+with\s+(.+)/);
  if (create) {
    return {
      action: "CREATE_GROUP",
      name: create[1]!.trim(),
      members: extractUsernames(create[2]!),
    };
  }

  // "add @user to <group> group"
  const addTo = lower.match(/add\s+@?(\w+)\s+to\s+(?:the\s+)?(.+?)\s+group\b/);
  if (addTo) {
    return {
      action: "ADD_TO_GROUP",
      groupName: addTo[2]!.trim(),
      member: addTo[1]!.toLowerCase(),
    };
  }

  // "remove @user from <group> group"
  const removeFrom = lower.match(/remove\s+@?(\w+)\s+from\s+(?:the\s+)?(.+?)\s+group\b/);
  if (removeFrom) {
    return {
      action: "REMOVE_FROM_GROUP",
      groupName: removeFrom[2]!.trim(),
      member: removeFrom[1]!.toLowerCase(),
    };
  }

  // "send $20 USDC to @tolu [for rent]"
  const sendSingle = lower.match(/send\s+[$]?\s*([\d,.]+k?)\s+(?:usdc\s+)?to\s+@?(\w+)(?:\s+for\s+(.+))?/);
  if (sendSingle) {
    const amount = parseMoneyAmount(sendSingle[1]!);
    if (amount) {
      return {
        action: "SEND_SINGLE",
        totalAmount: amount,
        recipient: sendSingle[2]!.toLowerCase(),
        note: sendSingle[3]?.trim(),
      };
    }
  }

  // "send $50 USDC to Friends group"
  const sendGroup = lower.match(/send\s+[$]?\s*([\d,.]+k?)\s+(?:usdc\s+)?to\s+(?:the\s+)?(.+?)\s+group\b/);
  if (sendGroup) {
    const amount = parseMoneyAmount(sendGroup[1]!);
    if (amount) {
      return {
        action: "GROUP_PAYMENT",
        totalAmount: amount,
        groupName: sendGroup[2]!.trim(),
      };
    }
  }

  // "split $100 USDC with @tolu @ada @john"
  const splitWith = lower.match(/split\s+[$]?\s*([\d,.]+k?)\s+(?:usdc\s+)?(?:with|among|between)\s+(.+)/);
  if (splitWith) {
    const amount = parseMoneyAmount(splitWith[1]!);
    const users = extractUsernames(splitWith[2]!);
    const nMatch = splitWith[2]!.match(/(\d+)\s+people/);
    if (amount && users.length >= 1) {
      return { action: "SPLIT_PAYMENT", totalAmount: amount, recipients: users };
    }
    if (amount && nMatch) {
      return { action: "SPLIT_COUNT", totalAmount: amount, count: Number(nMatch[1]) };
    }
  }

  return null;
}

// ── Groq LLM client ───────────────────────────────────────────────────────────

function createGroqClient(): OpenAI | null {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: GROQ_BASE_URL });
}

const groqClient = createGroqClient();

// ── Main export ───────────────────────────────────────────────────────────────

export async function parseIntent(text: string): Promise<Intent> {
  // Fast deterministic path — no API call needed
  const rule = ruleParse(text);
  if (rule) return rule;

  if (!groqClient) {
    // No LLM configured — default to HELP so the user sees usage instructions
    return { action: "HELP" };
  }

  const model =
    process.env.GROQ_CHAT_MODEL?.trim() ?? "llama-3.3-70b-versatile";

  let raw: string | null | undefined;
  try {
    const completion = await groqClient.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      temperature: 0.1,
    });
    raw = completion.choices[0]?.message?.content;
  } catch (err) {
    throw new Error(
      `Could not parse your message (LLM error): ${(err as Error).message}`,
    );
  }

  if (!raw) throw new Error("Empty response from AI model.");

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("AI returned invalid JSON — please rephrase your message.");
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("action" in data) ||
    typeof (data as Record<string, unknown>).action !== "string"
  ) {
    throw new Error(
      'Could not understand that. Try: "Send $20 to @tolu", "Find USDC yield above 5%", or type *help*.',
    );
  }

  return data as Intent;
}
