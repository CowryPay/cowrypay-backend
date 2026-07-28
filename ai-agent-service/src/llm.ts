import OpenAI from "openai";
import { parsedIntentSchema, type ParsedIntent } from "./schemas.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const SYSTEM = `You are Cowry's intent parser. Output ONLY valid JSON matching this shape:
- Register name for wallet (user signs tx): {"kind":"admin","action":"REGISTER_USERNAME","username":"lowercase_no_at"}
- Payment send to one user: {"kind":"payment","action":"SEND_SINGLE","amount":number,"recipient":"username without @","token":"USDC or USDm when user says which token"}
- Payment to group (same amount each member): {"kind":"payment","action":"SEND_TO_GROUP","perRecipientAmount":number,"groupName":"string","token":"USDC or USDm when specified"}
- Split total across a group (payGroupSplit): {"kind":"payment","action":"GROUP_SPLIT_TOTAL","amount":number,"groupName":"string","token":"USDC or USDm when specified"}
- Split total equally among named users: {"kind":"payment","action":"SPLIT_EQUAL","amount":number,"members":["user1","user2",...] without @,"token":"USDC or USDm when specified"}
- Approve token for CowryPay: {"kind":"admin","action":"APPROVE_USDC","amount":number,"token":"USDm or USDC"}
- Add members to group by id: {"kind":"admin","action":"ADD_MEMBERS","groupId":number,"members":["u1","u2"]}
- Remove members: {"kind":"admin","action":"REMOVE_MEMBERS","groupId":number,"members":["u1"]}
- Cancel group: {"kind":"admin","action":"CANCEL_GROUP","groupId":number}
- Create group: {"kind":"admin","action":"CREATE_GROUP","groupName":"string","members":["u1","u2"]}
- List groups: {"kind":"admin","action":"LIST_GROUPS"}
- Help / what can you do: {"kind":"admin","action":"HELP"}
- Show USDC yield vaults / earn / invest / Morpho / APY: {"kind":"earn","action":"LIST_OPPORTUNITIES"}
- Deposit into a vault (pick by number): {"kind":"earn","action":"DEPOSIT_YIELD","amount":number,"vaultIndex":number}
- Deposit (no vault specified): {"kind":"earn","action":"DEPOSIT_YIELD","amount":number,"vaultIndex":1}
- Show yield positions / what am I earning / my Morpho balance: {"kind":"earn","action":"VIEW_POSITIONS"}
- Check balance / how much do I have / my USDm balance / my USDC balance: {"kind":"admin","action":"BALANCE"}
- My transactions / transaction history / recent payments: {"kind":"admin","action":"BALANCE"}
- Greetings / general chat / questions about Cowry: {"kind":"admin","action":"CHAT"}

Rules: amounts are numbers (user may say dollars or $). Always set **token** to "USDC" or "USDm" when the user names a token; omit token only if they did not specify either. Usernames: a–z 0–9 only, 3–32 chars, no @ in JSON. For earn: vaultIndex is 1-based integer.`;

const CHAT_SYSTEM = `You are Cowry, an AI-powered crypto payment assistant built on Celo.
You help users send USDm and USDC payments using natural language.

Cowry capabilities:
• Send **USDC** or **USDm** to any @username: "Send 20 USDC to @ada" or "Send 5 USDm to @bob"
• Split bills: "Split 30 USDC among @tolu, @ada, @john"
• Group payments: "Send $50 to everyone in Friends group"
• Cross-chain: receive USDm/USDC on Celo from any chain via LI.FI bridge
• Earn yield: deposit USDC into Morpho vaults
• Check balance, manage groups, view transactions

When asked about balance or transactions: let the user know you can check their on-chain balance — suggest they type "my balance" or ask them to connect if not connected yet.

Keep responses SHORT (2-3 sentences max), friendly, and helpful. Use markdown bold (**text**) sparingly for key terms. Mention specific Cowry commands when relevant. Never make up transaction data.`;

/** Groq exposes an OpenAI-compatible Chat Completions API. */
export function createGroqClient(): OpenAI | null {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: GROQ_BASE_URL });
}

/** Parse a user message into a structured intent. */
export async function parseWithLlm(
  client: OpenAI,
  userMessage: string,
): Promise<ParsedIntent> {
  const model = process.env.GROQ_CHAT_MODEL?.trim() || "llama-3.3-70b-versatile";
  const completion = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: userMessage },
    ],
    temperature: 0.1,
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return { kind: "unknown", rawSummary: "empty model response" };
  let data: unknown;
  try { data = JSON.parse(raw); } catch {
    return { kind: "unknown", rawSummary: "invalid json from model" };
  }
  const parsed = parsedIntentSchema.safeParse(data);
  if (!parsed.success) return { kind: "unknown", rawSummary: parsed.error.message };
  return parsed.data;
}

/** Generate a conversational reply for general chat / unknown intents. */
export async function generateChatReply(
  client: OpenAI,
  userMessage: string,
  context?: { username?: string | null; walletAddress?: string },
): Promise<string> {
  const model = process.env.GROQ_CHAT_MODEL?.trim() || "llama-3.3-70b-versatile";

  const contextNote = context?.username
    ? `\nThe user's Cowry username is @${context.username}.`
    : context?.walletAddress
    ? `\nThe user's wallet: ${context.walletAddress.slice(0, 10)}…`
    : "";

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CHAT_SYSTEM + contextNote },
      { role: "user",   content: userMessage },
    ],
    temperature: 0.7,
    max_tokens: 200,
  });
  return completion.choices[0]?.message?.content?.trim() ?? "How can I help you today?";
}
