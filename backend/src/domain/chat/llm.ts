import OpenAI from "openai";

const SYSTEM_PROMPT = `You are the CowryPay assistant — a friendly, concise guide for a cross-border stablecoin payments app.
Keep replies short (2-4 sentences), plain language, no markdown tables.
You have no access to account data or tools — you cannot look up a real balance, deposit address, or move funds.
If asked about balance, deposit address, or sending money, tell the user to ask
"what's my balance", "what's my deposit address", or say "help" — don't invent numbers or addresses.
Sending/off-ramp isn't live yet; if asked to send money, say that's coming soon.`;

export function createGroqClient(apiKey: string | undefined): OpenAI | null {
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
}

export async function generateChatReply(client: OpenAI, message: string, model: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
    max_tokens: 200,
    temperature: 0.6,
  });
  return (
    completion.choices[0]?.message?.content?.trim() ??
    "Sorry, I didn't catch that — try asking about your balance or say 'help'."
  );
}
