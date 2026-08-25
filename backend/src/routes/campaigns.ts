import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
import { adminRepo } from "../domain/admin/repository.js";
import { campaignsRepo } from "../domain/campaigns/repository.js";
import { generateUnsubscribeToken, verifyUnsubscribeToken } from "../domain/campaigns/unsubscribeToken.js";
import { sendCampaignEmail } from "../domain/campaigns/resendClient.js";
import {
  FEEDBACK_CAMPAIGN_KEY,
  FEEDBACK_CAMPAIGN_SUBJECT,
  buildFeedbackCampaignEmail,
} from "../domain/campaigns/feedbackCampaign.js";

export const campaignsRouter = Router();

// Public — the link every campaign email's footer points to. No admin key
// (a recipient clicking this from their inbox isn't authenticated), gated
// instead by the HMAC token so only a link we actually generated works.
campaignsRouter.get("/campaigns/unsubscribe", async (req: Request, res: Response) => {
  const email = String(req.query.email ?? "");
  const token = String(req.query.token ?? "");
  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    res.status(400).send("This unsubscribe link is invalid or has expired.");
    return;
  }
  await campaignsRepo.unsubscribe(email);
  res
    .status(200)
    .send(`<!doctype html><html><body style="font-family:sans-serif;padding:48px;text-align:center;">
      <h2>You're unsubscribed</h2>
      <p>${email} won't receive marketing emails like this from CowryPay again.</p>
    </body></html>`);
});

const SendFeedbackCampaignSchema = z.object({
  actor: z.string().min(1),
  // When set, sends ONLY to this address (still subject to the unsubscribe
  // check) — the test-send step before the real bulk send.
  testEmail: z.string().email().optional(),
});

// Sequential with a small delay between sends rather than
// Promise.all — keeps well under Resend's rate limit and mirrors this
// codebase's existing style for batch operations (pollers process one
// record at a time, not in parallel).
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

campaignsRouter.post("/admin/campaigns/feedback/send", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = SendFeedbackCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", details: parsed.error.flatten() });
    return;
  }
  const { actor, testEmail } = parsed.data;

  if (!env.publicBaseUrl) {
    res.status(500).json({ error: "PUBLIC_BASE_URL must be set to generate unsubscribe links" });
    return;
  }

  const targets = testEmail
    ? [{ email: testEmail }]
    : (await adminRepo.listUserEmails()).map((u) => ({ email: u.email }));

  console.log(
    `[campaigns] feedback campaign send starting: actor=${actor}, targets=${targets.length}, testMode=${Boolean(testEmail)}`,
  );

  const results = { sent: 0, skippedUnsubscribed: 0, skippedAlreadySent: 0, failed: 0 };

  for (const { email } of targets) {
    try {
      if (await campaignsRepo.isUnsubscribed(email)) {
        results.skippedUnsubscribed++;
        continue;
      }
      // Skipped even in test mode is fine — re-POSTing with the same
      // testEmail twice shouldn't double-send either.
      if (await campaignsRepo.wasSent(FEEDBACK_CAMPAIGN_KEY, email)) {
        results.skippedAlreadySent++;
        continue;
      }

      const unsubscribeUrl = `${env.publicBaseUrl}/campaigns/unsubscribe?email=${encodeURIComponent(email)}&token=${generateUnsubscribeToken(email)}`;
      const { html, text } = buildFeedbackCampaignEmail(unsubscribeUrl);
      const sent = await sendCampaignEmail({ to: email, subject: FEEDBACK_CAMPAIGN_SUBJECT, html, text });
      await campaignsRepo.logSend(FEEDBACK_CAMPAIGN_KEY, email, "sent", sent.id);
      results.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[campaigns] send failed for ${email}:`, message);
      await campaignsRepo.logSend(FEEDBACK_CAMPAIGN_KEY, email, "failed", undefined, message);
      results.failed++;
    }
    await delay(400);
  }

  console.log(`[campaigns] feedback campaign send finished:`, results);
  res.json({ ok: true, ...results });
});
