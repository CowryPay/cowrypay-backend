import type OpenAI from "openai";
import { createGroqClient, parseWithLlm } from "./llm.js";
import { ruleParse } from "./ruleParser.js";
import type { ParsedIntent } from "./schemas.js";

export function createMessageParser(options?: {
  /** Groq client (OpenAI SDK with Groq base URL). Injected in tests. */
  llmClient?: OpenAI | null;
}): (text: string) => Promise<ParsedIntent> {
  const client = options?.llmClient ?? createGroqClient();

  return async (text: string) => {
    const ruled = ruleParse(text);
    if (ruled) return ruled;
    if (client) {
      try {
        return await parseWithLlm(client, text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: "unknown", rawSummary: msg };
      }
    }
    return {
      kind: "unknown",
      rawSummary: "no rule matched and GROQ_API_KEY is not set",
    };
  };
}
