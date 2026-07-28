import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isAddress } from "viem";
import { createResolutionDeps } from "@cowry/agent-core/deps/createDeps.js";
import { handleUserMessage } from "@cowry/agent-core/pipeline.js";
import { createMessageParser } from "@cowry/agent-core/parseMessage.js";

async function main() {
  const deps = createResolutionDeps();
  const parseMessage = createMessageParser();
  const sessionId = "cli";
  const rl = readline.createInterface({ input, output });

  console.log(
    `Cowry CLI — resolution: ${deps.mode}. Mock usernames: @tolu, @ada, @john; groups: Friends, Family.`,
  );
  console.log(
    "Optional: export WALLET=0x... for on-chain group list / group pay (chain mode).",
  );
  console.log("Commands: send 20 to @tolu | confirm | cancel | help | exit\n");

  const walletEnv = process.env.WALLET?.trim();
  const wallet =
    walletEnv && isAddress(walletEnv) ? (walletEnv as `0x${string}`) : undefined;

  for (;;) {
    const line = await rl.question("you> ");
    const t = line.trim();
    if (!t) continue;
    if (/^exit$/i.test(t)) break;

    const reply = await handleUserMessage(
      sessionId,
      t,
      deps,
      parseMessage,
      wallet,
    );
    console.log(JSON.stringify(reply, null, 2));
    console.log("");
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
