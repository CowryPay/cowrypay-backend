import type { ParsedMessage, WebhookBody } from "../types.js";

const BASE     = "https://graph.facebook.com/v19.0";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json() as { error?: { message?: string } };
  if (!res.ok) {
    console.error("WhatsApp API error:", json);
    throw new Error(json?.error?.message ?? "WhatsApp API error");
  }
  return json;
}

// ── Plain text message ────────────────────────────────────────────────────────
export async function sendMessage(to: string, text: string): Promise<unknown> {
  return post(`${PHONE_ID}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  });
}

// ── Interactive buttons (YES / NO confirmation) ───────────────────────────────
// WhatsApp supports up to 3 buttons per message.
export async function sendConfirmButtons(to: string, bodyText: string): Promise<unknown> {
  return post(`${PHONE_ID}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: [
          { type: "reply", reply: { id: "CONFIRM_YES", title: " Yes, send" } },
          { type: "reply", reply: { id: "CONFIRM_NO",  title: " Cancel"    } },
        ],
      },
    },
  });
}
 
// ── Mark message as read ──────────────────────────────────────────────────────
export async function markRead(messageId: string): Promise<unknown> {
  return post(`${PHONE_ID}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

// ── Parse incoming webhook body into a clean message object ──────────────────
export function parseIncoming(body: WebhookBody): ParsedMessage | null {
  try {
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

    if (!message) return null;

    // Handle both plain text and interactive button replies
    let text     = "";
    let buttonId: string | null = null;

    if (message.type === "text") {
      text = message.text?.body?.trim() ?? "";
    } else if (message.type === "interactive") {
      const reply = message.interactive?.button_reply;
      text     = reply?.title ?? "";
      buttonId = reply?.id   ?? null;
    } else {
      // Ignore voice, images, etc.
      return null;
    }

    return {
      phone:     message.from,
      messageId: message.id,
      text,
      buttonId,
      name:      contact?.profile?.name ?? null,
      timestamp: parseInt(message.timestamp) * 1000,
    };
  } catch {
    return null;
  }
}
