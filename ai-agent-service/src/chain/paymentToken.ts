import type { PublicClient } from "viem";
import { readErc20Balance } from "./erc20Reads.js";
import {
  DEFAULT_TOKEN,
  TOKENS,
  fromBaseUnits,
  getTokenBySymbol,
  toBaseUnits,
  type TokenSymbol,
} from "./tokenConfig.js";

export type PaymentTokenInfo = (typeof TOKENS)[TokenSymbol];

/** User named a token in chat, or we infer from balance / amount. */
export async function resolvePaymentToken(opts: {
  explicitSymbol?: string;
  wallet?: `0x${string}`;
  client?: PublicClient | null;
  amountHuman: number;
}): Promise<
  | { token: PaymentTokenInfo; clarify?: undefined }
  | { token?: undefined; clarify: string }
> {
  if (opts.explicitSymbol) {
    return { token: getTokenBySymbol(opts.explicitSymbol) };
  }

  if (!opts.wallet || !opts.client) {
    return { token: DEFAULT_TOKEN };
  }

  const entries = await Promise.all(
    (Object.values(TOKENS) as PaymentTokenInfo[]).map(async (token) => {
      const balance = await readErc20Balance(
        opts.client!,
        token.address,
        opts.wallet!,
      );
      const human = Number(fromBaseUnits(balance, token.decimals));
      const required = toBaseUnits(opts.amountHuman, token.decimals);
      return { token, balance, human, sufficient: balance >= required };
    }),
  );

  const sufficient = entries.filter((e) => e.sufficient);

  if (sufficient.length === 1) {
    return { token: sufficient[0]!.token };
  }

  if (sufficient.length > 1) {
    const amt = opts.amountHuman.toLocaleString();
    const lines = sufficient
      .map((e) => `• **${e.human.toLocaleString()} ${e.token.symbol}**`)
      .join("\n");
    return {
      clarify:
        `You have enough for **${amt}** in more than one token:\n${lines}\n\n` +
        `Specify which to send, e.g. **send ${amt} USDC to @name** or **send ${amt} USDm to @name**.`,
    };
  }

  // Neither token has enough — use whichever balance is higher so the error message is clearer
  entries.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  return { token: entries[0]?.token ?? DEFAULT_TOKEN };
}
