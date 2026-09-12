import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../../config/env.js";
import { parsedIntentSchema, type ParsedIntent } from "./schemas.js";
import type { Institution } from "../offramp/paycrestAdapter.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const INTENT_SYSTEM = `You are CowryPay's intent parser. Output ONLY valid JSON matching this shape:
- Send money to a bank account or mobile money abroad (remittance/off-ramp) — recipient does NOT need a CowryPay account. Use whenever the message mentions: "send", "bank account", "bank", "mobile money", "MoMo", "account number", "phone number", a country name (e.g. Nigeria, Kenya, Uganda, Tanzania, Malawi), or a saved nickname like "mom"/"my landlord". The amount can be named EITHER as a crypto/dollar figure ("$50", "20 USDC" → use "amount") OR as a local-currency figure the recipient should actually receive ("₦50,000", "50000 naira", "pay my vendor 20000 shillings" → use "fiatAmount" instead, never both):
  {"kind":"remittance","action":"SEND_REMITTANCE","amount":number,"fiatAmount":"number (a LOCAL-CURRENCY amount, e.g. Naira/Kenyan Shillings/Cedis — use this instead of amount when the figure is in that local currency, not dollars/crypto)","recipientNickname":"string (saved nickname if used, e.g. 'mom')","countryHint":"string (country if mentioned, e.g. 'Nigeria')","institutionHint":"string (bank or mobile money name if mentioned, e.g. 'GTBank', 'MTN MoMo')","accountIdentifier":"string (account/phone number if given)","chainHint":"string (which chain/network to send from, if named, e.g. 'Base', 'Celo', 'Optimism')","tokenHint":"string (which token, if named, e.g. 'USDC', 'USDT')"}
- Withdraw / send crypto to an external wallet ADDRESS on the SAME chain the user already holds it on (not a bank account, not mobile money, no country/institution/phone number — a raw wallet address instead, e.g. starting with "0x", "G", or a base58 string) — e.g. "withdraw to wallet", "send to my wallet", "send USDC to an address", "crypto withdrawal". Only one chain is ever named or implied here:
  {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":number,"toAddress":"string (the exact wallet address if given, copy it character-for-character, never guess or complete a partial one)","chainHint":"string (which chain, if named, e.g. 'Base', 'Celo', 'Optimism', 'Stellar', 'Solana')","tokenHint":"string (which token, if named, e.g. 'USDC', 'USDT')","memo":"string (Stellar only — a memo the user gives ALONGSIDE a real wallet address, e.g. an exchange deposit address that needs one to identify the recipient; copy digits/text exactly)"}
- Send to ANOTHER COWRYPAY USER on Stellar, identified by their CowryPay memo (a plain number), not a wallet address — e.g. "send to memo 1234 on cowrypay", "send to my friend's cowrypay memo 5678", "transfer 10 USDC to cowrypay user memo 999". The tell is the word "memo" (or "cowrypay memo"/"cowrypay user") paired with a number, with NO wallet address anywhere in the message — do not confuse this with cryptoWithdrawal's own optional memo field, used when a REAL wallet address is ALSO given (e.g. "withdraw to G... with memo 12345" — an exchange-style destination, still cryptoWithdrawal, memo just rides alongside the address):
  {"kind":"internalTransfer","action":"SEND_TO_COWRYPAY_USER","amount":number,"recipientMemoId":"string (the exact memo number, digits only, copy it character-for-character, never guess)","tokenHint":"string (which token, if named, e.g. 'USDC', 'USDT0')"}
- Move funds from one chain to a DIFFERENT chain (cross-chain send / bridge) — the user has balance on one chain but wants it (or wants to send it to someone) on a different chain. Recognize phrasing like "I have X on [chain A] but need it on [chain B]", "I have funds on celo but want them on base", "send from [chain A] to [chain B]", "bridge my USDC from X to Y", "move my USDC to base". The tell is TWO different chains being involved, one the money is currently on and a different one it should end up on — that's what separates this from cryptoWithdrawal (one chain only) and remittance (destination is a bank/mobile money, not a chain):
  {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","amount":number,"toAddress":"string (destination wallet address, if given, copy it EXACTLY character-for-character, never guess or complete a partial one)","sourceChainHint":"string (which chain the funds are currently on, e.g. 'Celo')","destinationChainHint":"string (which chain they should end up on, e.g. 'Base')","tokenHint":"string (which token, if named)"}
- Check balance / deposits: {"kind":"admin","action":"BALANCE"}
- Transaction history / recent sends: {"kind":"admin","action":"TX_HISTORY"}
- Help / what can you do: {"kind":"admin","action":"HELP"}
- Greetings / general chat / anything else: {"kind":"admin","action":"CHAT"}
- Asking what the current exchange rate is — NOT asking to send money, just checking a rate before deciding. Recognize "what's the rate", "how much is X in naira", "what's the exchange rate for USDC to KES", "rate check":
  {"kind":"rate","action":"CHECK_RATE","fiatCurrency":"string (e.g. 'NGN', 'KES' — if named)","tokenHint":"string (if named)","chainHint":"string (if named)","amount":"number (only if the user named a specific crypto amount to check, e.g. 'rate for 50 USDC')"}

Examples:
- "Send $50 to a bank account in Nigeria" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":50,"countryHint":"Nigeria"}
- "Send $20 to mobile money in Kenya, 0712345678" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":20,"countryHint":"Kenya","accountIdentifier":"0712345678"}
- "Send $50 to Nigeria via Base" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":50,"countryHint":"Nigeria","chainHint":"Base"}
- "I want to withdraw to wallet" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET"}
- "Withdraw 20 USDC to 0x1234567890abcdef1234567890abcdef12345678 on Base" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":20,"toAddress":"0x1234567890abcdef1234567890abcdef12345678","chainHint":"Base"}
- "Send 5 USDC to GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":5,"toAddress":"GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"}
- "Withdraw 20 USDC to GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37 with memo 12345" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":20,"toAddress":"GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37","memo":"12345"}
- "Send 20 USDT to Nigeria via Celo" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":20,"countryHint":"Nigeria","chainHint":"Celo","tokenHint":"USDT"}
- "I have 10 USDC on celo but I need it to be on base" → {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","amount":10,"sourceChainHint":"Celo","destinationChainHint":"Base"}
- "Move 25 USDC from Solana to Base, to 0x1234567890abcdef1234567890abcdef12345678" → {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","amount":25,"sourceChainHint":"Solana","destinationChainHint":"Base","toAddress":"0x1234567890abcdef1234567890abcdef12345678"}
- "I want to send someone on base but I only have celo" → {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","sourceChainHint":"Celo","destinationChainHint":"Base"}
- "Send 15 USDC from Base to Stellar, to GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" → {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","amount":15,"sourceChainHint":"Base","destinationChainHint":"Stellar","toAddress":"GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"}
- "Send 10 USDC from Stellar to Base, to 0x1234567890abcdef1234567890abcdef12345678" → {"kind":"crossChainSend","action":"SEND_CROSS_CHAIN","amount":10,"sourceChainHint":"Stellar","destinationChainHint":"Base","toAddress":"0x1234567890abcdef1234567890abcdef12345678"}
- "Send 10 USDC to cowrypay memo 1003" → {"kind":"internalTransfer","action":"SEND_TO_COWRYPAY_USER","amount":10,"recipientMemoId":"1003"}
- "I want to send to someone on cowrypay" → {"kind":"internalTransfer","action":"SEND_TO_COWRYPAY_USER"}
- "Transfer 5 USDT0 to memo 42" → {"kind":"internalTransfer","action":"SEND_TO_COWRYPAY_USER","amount":5,"recipientMemoId":"42","tokenHint":"USDT0"}
- "What's my balance" → {"kind":"admin","action":"BALANCE"}
- "What can you do" → {"kind":"admin","action":"HELP"}
- "Pay my vendor ₦50,000, GTBank, 0123456789" → {"kind":"remittance","action":"SEND_REMITTANCE","fiatAmount":50000,"countryHint":"Nigeria","institutionHint":"GTBank","accountIdentifier":"0123456789"}
- "Send 20000 shillings to mobile money in Kenya, 0712345678" → {"kind":"remittance","action":"SEND_REMITTANCE","fiatAmount":20000,"countryHint":"Kenya","accountIdentifier":"0712345678"}
- "Send ₦100,000 to mom" → {"kind":"remittance","action":"SEND_REMITTANCE","fiatAmount":100000,"recipientNickname":"mom"}
- "What's the rate" → {"kind":"rate","action":"CHECK_RATE"}
- "What's the USDC to naira rate right now" → {"kind":"rate","action":"CHECK_RATE","fiatCurrency":"NGN"}
- "How much is 50 USDC in Kenyan shillings" → {"kind":"rate","action":"CHECK_RATE","fiatCurrency":"KES","amount":50}

Rules: amounts are numbers (user may say dollars or $). If a message describes sending money but doesn't cleanly fit remittance, still classify it as remittance with whatever fields you can extract — missing fields get asked for separately, don't invent them. For cryptoWithdrawal's and crossChainSend's toAddress, copy the address EXACTLY as written, character-for-character — never correct, complete, guess, or normalize it in any way, even if it looks malformed; a wrong character here is unrecoverable money loss, so an uncertain or partial address must be left out entirely rather than guessed at. Same discipline for internalTransfer's recipientMemoId — copy the digits exactly, never guess or complete a partial one. If a message mentions sending Stellar USDC/USDT0 to "someone on cowrypay"/"a cowrypay user"/"a memo" without a wallet address, that's internalTransfer, never cryptoWithdrawal — a raw wallet address (0x..., G..., or base58) means cryptoWithdrawal instead, and if a memo is ALSO given alongside that address, put it in cryptoWithdrawal's own memo field rather than switching to internalTransfer. tokenHint should only ever be "USDC", "USDT", or "USDT0" (case-insensitive as heard) — leave it out if no token is named or it's some other word. For remittance, never set both amount and fiatAmount on the same message — recognize which currency the number is actually in (₦/naira/NGN, KSh/shillings/KES, GHS/cedis, etc. are all fiatAmount; $/USDC/USDT/USDT0 are amount) and use only that one field.`;

const CHAT_SYSTEM = `You are CowryPay's assistant — a friendly, concise guide for a cross-border stablecoin payments app.

CowryPay capabilities:
• Hold a stablecoin balance — deposit USDC to your personal deposit address
• Send money abroad to a bank account or mobile money — recipient doesn't need a CowryPay account
• Check your balance and recent deposits

Keep responses SHORT (2-3 sentences max), friendly, plain conversational text. Do not use markdown formatting of any kind — no headers, no bold, no bullet points. You have no access to real account data or tools — never invent a balance, address, or transaction. If asked about balance or deposit address, tell the user to ask "what's my balance" or "what's my deposit address" instead.`;

/** Groq exposes an OpenAI-compatible Chat Completions API. Fast + cheap — the default for everything. */
export function createGroqClient(): OpenAI | null {
  if (!env.groqApiKey) return null;
  return new OpenAI({ apiKey: env.groqApiKey, baseURL: GROQ_BASE_URL });
}

/**
 * Claude — slower and pricier than Groq, so it's only ever used as a
 * fallback for the handful of calls where Groq comes back empty (no
 * confident match, or unavailable), not as the default path.
 */
function createAnthropicClient(): Anthropic | null {
  if (!env.anthropicApiKey) return null;
  return new Anthropic({ apiKey: env.anthropicApiKey });
}

/** Parse a user message into a structured intent. */
export async function parseWithLlm(client: OpenAI, userMessage: string, signal?: AbortSignal): Promise<ParsedIntent> {
  const completion = await client.chat.completions.create(
    {
      model: env.groqModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INTENT_SYSTEM },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
    },
    { signal },
  );
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return { kind: "unknown", rawSummary: "empty model response" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "unknown", rawSummary: "invalid json from model" };
  }
  const parsed = parsedIntentSchema.safeParse(data);
  if (!parsed.success) return { kind: "unknown", rawSummary: parsed.error.message };
  return parsed.data;
}

const institutionResolutionSchema = z.object({ index: z.number().int().nullable() });

function institutionResolutionPrompt(institutions: Institution[]): string {
  const list = institutions.map((inst, i) => `${i}. ${inst.name}`).join("\n");
  return `You match a user's free-text bank or mobile-money provider name against a fixed numbered list. The user may use abbreviations, slang, or typos (e.g. "momo" or "MTN" for "MTN Mobile Money", "GTB" for "GTBank"). Pick the SINGLE best-matching index. If nothing is a confident match, or the text could plausibly mean more than one entry, return null — do not guess. Respond with ONLY JSON: {"index": <number or null>}.

List:
${list}`;
}

function parseIndexResponse(raw: string | null | undefined, institutions: Institution[]): Institution | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Claude sometimes wraps JSON in a markdown code fence despite instructions.
    const match = raw.match(/\{[^}]*\}/);
    if (!match) return null;
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  const parsed = institutionResolutionSchema.safeParse(data);
  if (!parsed.success || parsed.data.index == null) return null;
  return institutions[parsed.data.index] ?? null;
}

async function resolveInstitutionWithGroq(
  query: string,
  institutions: Institution[],
  signal?: AbortSignal,
): Promise<Institution | null> {
  const client = createGroqClient();
  if (!client) return null;
  try {
    const completion = await client.chat.completions.create(
      {
        model: env.groqModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: institutionResolutionPrompt(institutions) },
          { role: "user", content: query },
        ],
        temperature: 0,
      },
      { signal },
    );
    return parseIndexResponse(completion.choices[0]?.message?.content, institutions);
  } catch (err) {
    // Real incident this closes: GROQ_MODEL pointed at a model Groq had
    // fully decommissioned, and every call site swallowed the failure
    // silently — nothing showed up anywhere until someone happened to
    // test it directly. Logged now so a bad model name, an outage, or a
    // rate limit shows up immediately instead of silently degrading to
    // Claude/static fallbacks for an unknown span of time.
    console.error("[llm] Groq institution resolution failed:", err);
    return null;
  }
}

async function resolveInstitutionWithClaude(
  query: string,
  institutions: Institution[],
  signal?: AbortSignal,
): Promise<Institution | null> {
  const client = createAnthropicClient();
  if (!client) return null;
  try {
    const msg = await client.messages.create(
      {
        model: env.anthropicModel,
        max_tokens: 50,
        system: institutionResolutionPrompt(institutions),
        messages: [{ role: "user", content: query }],
      },
      { signal },
    );
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return parseIndexResponse(block?.text, institutions);
  } catch (err) {
    console.error("[llm] Claude institution resolution failed:", err);
    return null;
  }
}

/**
 * Resolve a free-text bank / mobile-money name against the live institution
 * list for a currency, using an LLM as a fallback for whatever
 * ai-agent/offramp/institutionMatch.ts's deterministic fuzzy matcher
 * couldn't resolve. The model only ever returns an INDEX into the list we
 * hand it, never a name or code — so it cannot hallucinate an institution
 * that doesn't exist; we map the index back ourselves.
 *
 * Tries Groq first (fast, cheap). Only escalates to Claude when Groq comes
 * back with no confident match.
 */
export async function resolveInstitutionWithLlm(
  query: string,
  institutions: Institution[],
  signal?: AbortSignal,
): Promise<Institution | null> {
  if (institutions.length === 0) return null;

  const groqMatch = await resolveInstitutionWithGroq(query, institutions, signal);
  if (groqMatch) return groqMatch;

  return resolveInstitutionWithClaude(query, institutions, signal);
}

/**
 * Generate a conversational reply for general chat / unknown intents.
 * Groq first (fast, cheap); Claude only as a fallback if Groq is
 * unavailable or errors, so the pricier model isn't on the default path.
 */
export async function generateChatReply(userMessage: string, signal?: AbortSignal): Promise<string> {
  const groq = createGroqClient();
  if (groq) {
    try {
      const completion = await groq.chat.completions.create(
        {
          model: env.groqModel,
          messages: [
            { role: "system", content: CHAT_SYSTEM },
            { role: "user", content: userMessage },
          ],
          temperature: 0.7,
          max_tokens: 200,
        },
        { signal },
      );
      const reply = completion.choices[0]?.message?.content?.trim();
      if (reply) return reply;
    } catch (err) {
      // Logged, not silent — see resolveInstitutionWithGroq's comment on
      // the real incident (a decommissioned model) this exists to catch
      // early next time instead of only noticing once a user complains.
      console.error("[llm] Groq chat reply failed, falling through to Claude:", err);
    }
  }

  const anthropic = createAnthropicClient();
  if (anthropic) {
    try {
      const msg = await anthropic.messages.create(
        {
          model: env.anthropicModel,
          max_tokens: 200,
          system: CHAT_SYSTEM,
          messages: [{ role: "user", content: userMessage }],
        },
        { signal },
      );
      const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (block?.text?.trim()) return block.text.trim();
    } catch (err) {
      console.error("[llm] Claude chat reply failed, falling through to static reply:", err);
      // fall through to the static reply below
    }
  }

  return `I didn't quite catch that — try asking "what's my balance", "what's my deposit address", or say "help" to see what I can do.`;
}
