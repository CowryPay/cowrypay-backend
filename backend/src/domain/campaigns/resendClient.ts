import { env } from "../../config/env.js";

export interface SendCampaignEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Plain fetch against Resend's REST API rather than pulling in their SDK —
// matches this codebase's existing style for lightweight third-party
// integrations (see monitoring/telegram.ts, wallets/solanaAdapter.ts's
// Helius calls) rather than adding a dependency for one endpoint.
export async function sendCampaignEmail(input: SendCampaignEmailInput): Promise<{ id: string }> {
  if (!env.resendApiKey) {
    throw new Error("RESEND_API_KEY must be set to send campaign emails");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.campaignFromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id: string };
  return { id: data.id };
}
