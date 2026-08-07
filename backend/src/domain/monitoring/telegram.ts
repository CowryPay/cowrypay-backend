import { env } from "../../config/env.js";

// Bare fetch against Telegram's Bot API — no SDK needed for a single
// sendMessage call. Logs instead of throwing on failure/missing config,
// since a broken ops alert must never be the thing that crashes a poller.
export async function sendTelegramOpsAlert(text: string): Promise<void> {
  if (!env.telegramBotToken || !env.telegramOpsChatId) {
    console.log(`[telegram-ops-alert] not configured, would have sent:\n${text}`);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.telegramOpsChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[telegram-ops-alert] send failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error("[telegram-ops-alert] send failed:", err);
  }
}
