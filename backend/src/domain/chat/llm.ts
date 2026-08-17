import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../../config/env.js";
import { parsedIntentSchema, type ParsedIntent } from "./schemas.js";
import type { Institution } from "../offramp/paycrestAdapter.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const INTENT_SYSTEM = `You are CowryPay's intent parser. Output ONLY valid JSON matching this shape:
- Send money to a bank account or mobile money abroad (remittance/off-ramp) — recipient does NOT need a CowryPay account. Use whenever the message mentions: "send", "bank account", "bank", "mobile money", "MoMo", "account number", "phone number", a country name (e.g. Nigeria, Kenya, Uganda, Tanzania, Malawi), or a saved nickname like "mom"/"my landlord":
  {"kind":"remittance","action":"SEND_REMITTANCE","amount":number,"recipientNickname":"string (saved nickname if used, e.g. 'mom')","countryHint":"string (country if mentioned, e.g. 'Nigeria')","institutionHint":"string (bank or mobile money name if mentioned, e.g. 'GTBank', 'MTN MoMo')","accountIdentifier":"string (account/phone number if given)","chainHint":"string (which chain/network to send from, if named, e.g. 'Base', 'Celo', 'Optimism')"}
- Withdraw / send crypto to an external wallet ADDRESS (not a bank account, not mobile money, no country/institution/phone number — a raw wallet address instead, e.g. starting with "0x", "G", or a base58 string) — e.g. "withdraw to wallet", "send to my wallet", "send USDC to an address", "crypto withdrawal":
  {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":number,"toAddress":"string (the exact wallet address if given, copy it character-for-character, never guess or complete a partial one)","chainHint":"string (which chain, if named, e.g. 'Base', 'Celo', 'Optimism', 'Stellar', 'Solana')"}
- Check balance / deposits: {"kind":"admin","action":"BALANCE"}
- Transaction history / recent sends: {"kind":"admin","action":"TX_HISTORY"}
- Help / what can you do: {"kind":"admin","action":"HELP"}
- Greetings / general chat / anything else: {"kind":"admin","action":"CHAT"}

Examples:
- "Send $50 to a bank account in Nigeria" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":50,"countryHint":"Nigeria"}
- "Send $20 to mobile money in Kenya, 0712345678" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":20,"countryHint":"Kenya","accountIdentifier":"0712345678"}
- "Send $50 to Nigeria via Base" → {"kind":"remittance","action":"SEND_REMITTANCE","amount":50,"countryHint":"Nigeria","chainHint":"Base"}
- "I want to withdraw to wallet" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET"}
- "Withdraw 20 USDC to 0x1234567890abcdef1234567890abcdef12345678 on Base" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":20,"toAddress":"0x1234567890abcdef1234567890abcdef12345678","chainHint":"Base"}
- "Send 5 USDC to GBCPVOCOV3IX65YC6INLZKJTJPMJ77BTF7OYVIN6572FJNXDLKLKWXZD" → {"kind":"cryptoWithdrawal","action":"WITHDRAW_TO_WALLET","amount":5,"toAddress":"GBCPVOCOV3IX65YC6INLZKJTJPMJ77BTF7OYVIN6572FJNXDLKLKWXZD"}
- "What's my balance" → {"kind":"admin","action":"BALANCE"}
- "What can you do" → {"kind":"admin","action":"HELP"}

Rules: amounts are numbers (user may say dollars or $). If a message describes sending money but doesn't cleanly fit remittance, still classify it as remittance with whatever fields you can extract — missing fields get asked for separately, don't invent them. For cryptoWithdrawal's toAddress, copy the address EXACTLY as written, character-for-character — never correct, complete, guess, or normalize it in any way, even if it looks malformed; a wrong character here is unrecoverable money loss, so an uncertain or partial address must be left out entirely rather than guessed at.`;

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
  } catch {
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
  } catch {
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
    } catch {
      // fall through to Claude
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
    } catch {
      // fall through to the static reply below
    }
  }

  return `I didn't quite catch that — try asking "what's my balance", "what's my deposit address", or say "help" to see what I can do.`;
}
