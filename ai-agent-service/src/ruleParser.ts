import type { ParsedIntent } from "./schemas.js";

const STOP = new Set([
  "to",
  "in",
  "with",
  "group",
  "everyone",
  "among",
  "between",
  "split",
  "send",
  "people",
  "want",
  "the",
  "my",
  "usd",
  "dollar",
  "dollars",
  "and",
]);

function paymentToken(raw: string | undefined): "USDC" | "USDm" | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (t === "usdc") return "USDC";
  if (t === "usdm") return "USDm";
  if (t === "usd" || t.startsWith("dollar")) return "USDC";
  return undefined;
}

function withPaymentToken<T extends ParsedIntent>(intent: T, tokenRaw: string | undefined): T {
  const token = paymentToken(tokenRaw);
  return token ? ({ ...intent, token } as T) : intent;
}

/** Captures optional token after amount: "1 USDC", "20 usdm", "$5", etc. */
const AMT_TOKEN = String.raw`([\d,]+(?:\.\d+)?)\s*\$?\s*(usdc|usdm|usd|dollars?)?`;

function extractUsernames(segment: string): string[] {
  const out: string[] = [];
  for (const x of segment.matchAll(/@?([a-z0-9_]+)/gi)) {
    const w = x[1].toLowerCase();
    if (!STOP.has(w)) out.push(w);
  }
  return out;
}

function parseMoneyAmount(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Deterministic parser for tests and offline use.
 * Returns null if no rule matches (caller may try LLM).
 */
export function ruleParse(message: string): ParsedIntent | null {
  const raw = message.trim();
  const lower = raw.toLowerCase();

  if (/^(list|show)\s+(my\s+)?groups\b/.test(lower) || /^what\s+groups/.test(lower)) {
    return { kind: "admin", action: "LIST_GROUPS" };
  }

  // BALANCE: "my balance", "balance", "how much do I have", "check balance"
  if (/^(my\s+)?balance\s*\.?$/i.test(lower) || /\bcheck\s+(my\s+)?balance\b/i.test(lower) || /\bhow\s+much\s+(do\s+i\s+have|usdc|usdm)\b/i.test(lower)) {
    return { kind: "admin", action: "BALANCE" };
  }

  // Greetings → welcome message
  if (/^(hi|hello|hey|start|good\s+morning|good\s+evening|what.s\s+up|sup)\b/i.test(lower)) {
    return { kind: "admin", action: "CHAT" };
  }

  // ── LI.FI Earn rules ──────────────────────────────────────────────────────

  // VIEW_POSITIONS: "show my yield positions", "what am I earning", "my positions"
  if (
    /\b(my|show)\b.*\b(position|earning|yield|deposit)\b/i.test(lower) ||
    /\b(what|how much)\b.*(earn|yield|position|morpho)\b/i.test(lower) ||
    /^(my\s+)?positions?\s*$/i.test(lower)
  ) {
    return { kind: "earn", action: "VIEW_POSITIONS" };
  }

  // DEPOSIT_YIELD: "deposit 0.1 usdc into vault 1", "put $50 into morpho", "deposit 0.1 into 1"
  const depositVault = lower.match(
    /(?:deposit|put|invest)\s+\$?\s*([\d.]+)\s*(?:usdc|usd|dollars?)?\s+(?:into|in|to)\s+(?:vault\s+)?(\d+|morpho|top)/i,
  );
  if (depositVault) {
    const amount = parseMoneyAmount(depositVault[1]!);
    const raw2 = depositVault[2]!.trim().toLowerCase();
    const vaultIndex = raw2 === "morpho" || raw2 === "top" ? 1 : parseInt(raw2, 10);
    if (amount != null) {
      return {
        kind: "earn",
        action: "DEPOSIT_YIELD",
        amount,
        vaultIndex: Number.isFinite(vaultIndex) ? vaultIndex : 1,
      };
    }
  }

  // DEPOSIT_YIELD (no vault specified): "deposit 0.1 usdc", "earn with 0.05 usdc"
  const depositSimple = lower.match(
    /^(?:deposit|invest|earn\s+with)\s+\$?\s*([\d.]+)\s*(?:usdc|usd|dollars?)?\s*\.?$/i,
  );
  if (depositSimple) {
    const amount = parseMoneyAmount(depositSimple[1]!);
    if (amount != null) {
      return { kind: "earn", action: "DEPOSIT_YIELD", amount, vaultIndex: 1 };
    }
  }

  // LIST_OPPORTUNITIES: "earn yield", "show vaults", "morpho", "best apy", "yield options"
  if (
    /\b(earn|yield|vault|invest|apy|morpho|usdc.*vault|best.*rate)\b/i.test(lower) &&
    !/\b(send|pay|split|register|approve|group)\b/i.test(lower)
  ) {
    return { kind: "earn", action: "LIST_OPPORTUNITIES" };
  }

  if (lower.includes("help") && lower.split(/\s+/).length <= 3) {
    return { kind: "admin", action: "HELP" };
  }

  const approveFor = raw.match(
    new RegExp(`^approve\\s+\\$?\\s*${AMT_TOKEN}\\s+for\\s+cowry(?:pay)?\\s*\\.?$`, "i"),
  );
  if (approveFor) {
    const amount = parseMoneyAmount(approveFor[1]!);
    if (amount != null) {
      return withPaymentToken(
        { kind: "admin", action: "APPROVE_USDC", amount },
        approveFor[2],
      );
    }
  }

  const approveSpend = raw.match(
    new RegExp(
      `^(?:approve|allow)\\s+cowry(?:pay)?\\s+to\\s+spend\\s+\\$?\\s*${AMT_TOKEN}\\s*\\.?$`,
      "i",
    ),
  );
  if (approveSpend) {
    const amount = parseMoneyAmount(approveSpend[1]!);
    if (amount != null) {
      return withPaymentToken(
        { kind: "admin", action: "APPROVE_USDC", amount },
        approveSpend[2],
      );
    }
  }

  const register = raw.match(
    /^(?:i\s+want\s+to\s+)?(?:register|claim)(?:\s+username)?(?:\s+as)?\s+@?([a-z0-9]{3,32})\s*\.?$/i,
  );
  if (register) {
    return {
      kind: "admin",
      action: "REGISTER_USERNAME",
      username: register[1]!.toLowerCase(),
    };
  }

  const splitGroupTotal = raw.match(
    new RegExp(`(?:split|divide)\\s+\\$?\\s*${AMT_TOKEN}\\s+(?:across|in|into)\\s+(?:the\\s+)?(?:group\\s+)?(.+?)\\s*$`, "i"),
  );
  if (splitGroupTotal) {
    const amount = parseMoneyAmount(splitGroupTotal[1]!);
    let gname = splitGroupTotal[3]!.trim();
    gname = gname.replace(/\s+group\s*$/i, "").replace(/^\s*group\s+/i, "").trim();
    if (amount != null && gname.length > 0) {
      return withPaymentToken(
        {
          kind: "payment",
          action: "GROUP_SPLIT_TOTAL",
          amount,
          groupName: gname,
        },
        splitGroupTotal[2],
      );
    }
  }

  const addMembers = raw.match(/^add\s+(.+?)\s+to\s+group\s+(\d+)\s*\.?$/i);
  if (addMembers) {
    const users = extractUsernames(addMembers[1]!);
    if (users.length >= 1) {
      return {
        kind: "admin",
        action: "ADD_MEMBERS",
        groupId: addMembers[2]!,
        members: users,
      };
    }
  }

  const removeMembers = raw.match(/^remove\s+(.+?)\s+from\s+group\s+(\d+)\s*\.?$/i);
  if (removeMembers) {
    const users = extractUsernames(removeMembers[1]!);
    if (users.length >= 1) {
      return {
        kind: "admin",
        action: "REMOVE_MEMBERS",
        groupId: removeMembers[2]!,
        members: users,
      };
    }
  }

  const cancelGroup = raw.match(/^(?:cancel|close)\s+group\s+(\d+)\s*\.?$/i);
  if (cancelGroup) {
    return {
      kind: "admin",
      action: "CANCEL_GROUP",
      groupId: cancelGroup[1]!,
    };
  }

  const create = lower.match(
    /create\s+group\s+['"]?([^'"’]+?)['"]?\s+with\s+(.+)/i,
  );
  if (create) {
    const groupName = create[1].trim();
    const members = extractUsernames(create[2]);
    return { kind: "admin", action: "CREATE_GROUP", groupName, members };
  }

  const casualGroup = raw.match(
    new RegExp(
      `(?:i\\s+want\\s+to\\s+)?send\\s+\\$?\\s*${AMT_TOKEN}\\s+to\\s+(?:a\\s+)?group\\s+(.+)`,
      "i",
    ),
  );
  if (casualGroup) {
    const amount = parseMoneyAmount(casualGroup[1]!);
    const groupName = casualGroup[3]!.replace(/\bgroup\b/gi, "").trim();
    if (amount != null) {
      return withPaymentToken(
        {
          kind: "payment",
          action: "SEND_TO_GROUP",
          perRecipientAmount: amount,
          groupName: groupName.length > 0 ? groupName : "group",
        },
        casualGroup[2],
      );
    }
  }

  const casualGroupNamed = raw.match(
    new RegExp(
      `(?:i\\s+want\\s+to\\s+)?send\\s+\\$?\\s*${AMT_TOKEN}\\s+to\\s+(?:the\\s+)?(.+?)\\s+group\\b`,
      "i",
    ),
  );
  if (casualGroupNamed) {
    const amount = parseMoneyAmount(casualGroupNamed[1]!);
    const groupName = casualGroupNamed[3]!.trim();
    if (amount != null && groupName.length > 0) {
      return withPaymentToken(
        {
          kind: "payment",
          action: "SEND_TO_GROUP",
          perRecipientAmount: amount,
          groupName,
        },
        casualGroupNamed[2],
      );
    }
  }

  const sendGroup = lower.match(
    new RegExp(`send\\s+\\$?\\s*${AMT_TOKEN}\\s+to\\s+everyone\\s+in\\s+(.+)`),
  );
  if (sendGroup) {
    const amount = parseMoneyAmount(sendGroup[1]!);
    if (amount != null) {
      const groupName = sendGroup[3]!.replace(/\bgroup\b/gi, "").trim();
      return withPaymentToken(
        {
          kind: "payment",
          action: "SEND_TO_GROUP",
          perRecipientAmount: amount,
          groupName,
        },
        sendGroup[2],
      );
    }
  }

  const sendSingle = lower.match(
    new RegExp(`send\\s+\\$?\\s*${AMT_TOKEN}\\s+to\\s+@?(\\w+)`),
  );
  if (sendSingle) {
    const amount = parseMoneyAmount(sendSingle[1]!);
    if (amount != null) {
      return withPaymentToken(
        {
          kind: "payment",
          action: "SEND_SINGLE",
          amount,
          recipient: sendSingle[3]!,
        },
        sendSingle[2],
      );
    }
  }

  const splitAmong = lower.match(
    new RegExp(`split\\s+\\$?\\s*${AMT_TOKEN}\\s+among\\s+(.+)`, "i"),
  );
  if (splitAmong) {
    const total = parseMoneyAmount(splitAmong[1]!);
    const rest = splitAmong[3]!;
    const users = extractUsernames(rest);
    const mPeople = rest.match(/(\d+)\s+people/);
    if (total != null && users.length >= 2) {
      return withPaymentToken(
        {
          kind: "payment",
          action: "SPLIT_EQUAL",
          amount: total,
          splitCount: users.length,
          members: users,
        },
        splitAmong[2],
      );
    }
    if (total != null && mPeople) {
      const n = Number(mPeople[1]);
      return withPaymentToken(
        {
          kind: "payment",
          action: "SPLIT_EQUAL",
          amount: total,
          splitCount: n,
        },
        splitAmong[2],
      );
    }
  }

  return null;
}
