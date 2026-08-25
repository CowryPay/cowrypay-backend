// Content + HTML for the "what should we build next" feedback campaign
// (2026-08 send to existing users). Deliberately its own file rather than a
// generic template builder — a one-off campaign's copy doesn't need to be
// reusable, and the next campaign is likely to look nothing like this one.

export const FEEDBACK_CAMPAIGN_KEY = "2026-08-feedback-crosschain";
export const FEEDBACK_CAMPAIGN_SUBJECT = "What should we build next at CowryPay?";

const FEEDBACK_FORM_URL = "https://forms.gle/gwGtQF8oGMiT7R8m9";
const APP_URL = "https://cowrypay.xyz/";

export function buildFeedbackCampaignEmail(unsubscribeUrl: string): { html: string; text: string } {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f2ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f2ee;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#12172b;padding:28px 32px;">
                <span style="color:#f2d9a8;font-size:20px;font-weight:700;letter-spacing:0.02em;">CowryPay</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0 0 20px 0;color:#12172b;font-size:16px;line-height:1.6;">Hi, good day, and happy new week! 👋</p>
                <p style="margin:0 0 20px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  You've been with CowryPay since the early days, and we'd really love to hear from you.
                </p>
                <p style="margin:0 0 24px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  <strong>What's working? What's frustrating? What would make CowryPay more useful for you?</strong>
                </p>
                <p style="margin:0 0 24px 0;color:#4a5068;font-size:15px;line-height:1.6;">
                  We've put together a short feedback form that takes about <strong>2 minutes</strong> to complete.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;">
                  <tr>
                    <td style="background-color:#d4a24c;border-radius:8px;">
                      <a href="${FEEDBACK_FORM_URL}" style="display:inline-block;padding:14px 28px;color:#12172b;font-size:15px;font-weight:700;text-decoration:none;">Share your feedback</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 32px 0;color:#4a5068;font-size:14px;line-height:1.6;">
                  Your responses will directly help us decide what we build next.
                </p>
                <hr style="border:none;border-top:1px solid #e7e3da;margin:0 0 28px 0;" />
                <p style="margin:0 0 12px 0;color:#12172b;font-size:16px;font-weight:700;">🚀 Also, something new</p>
                <p style="margin:0 0 12px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  We've just launched <strong>Cross-Chain Send</strong> — you can now move stablecoins between
                  chains without manually bridging anything yourself. For example: you have USDC on Celo, but
                  you need to send it to someone on Base.
                </p>
                <p style="margin:0 0 16px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  Just tell the AI: <em>"I want to send my USDC on Celo to someone on Base"</em> — and CowryPay
                  handles the rest.
                </p>
                <p style="margin:0 0 16px 0;color:#4a5068;font-size:14px;line-height:1.6;">
                  Supported chains: <strong>Celo, Base, and Solana</strong>.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px 0;">
                  <tr>
                    <td style="border:1px solid #12172b;border-radius:8px;">
                      <a href="${APP_URL}" style="display:inline-block;padding:14px 28px;color:#12172b;font-size:15px;font-weight:700;text-decoration:none;">Try CowryPay</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 4px 0;color:#12172b;font-size:15px;line-height:1.6;">
                  Thanks for being one of our early users. We're building CowryPay with you, and your feedback genuinely matters.
                </p>
                <p style="margin:24px 0 0 0;color:#12172b;font-size:15px;font-weight:700;">— The CowryPay Team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;">
                <p style="margin:0;color:#9aa3b5;font-size:12px;line-height:1.6;">
                  You're receiving this because you have a CowryPay account.
                  <a href="${unsubscribeUrl}" style="color:#9aa3b5;">Unsubscribe from emails like this</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `Hi, good day, and happy new week!

You've been with CowryPay since the early days, and we'd really love to hear from you.

What's working? What's frustrating? What would make CowryPay more useful for you?

Share your feedback (2 minutes): ${FEEDBACK_FORM_URL}

Your responses will directly help us decide what we build next.

---

Also, something new: we've just launched Cross-Chain Send — you can now move stablecoins between chains without manually bridging anything yourself. For example: you have USDC on Celo, but you need to send it to someone on Base.

Just tell the AI: "I want to send my USDC on Celo to someone on Base" — and CowryPay handles the rest.

Supported chains: Celo, Base, and Solana.

Try CowryPay: ${APP_URL}

Thanks for being one of our early users. We're building CowryPay with you, and your feedback genuinely matters.

— The CowryPay Team

---
Unsubscribe from emails like this: ${unsubscribeUrl}`;

  return { html, text };
}
