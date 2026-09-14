// Content + HTML for the "USDT0 on Stellar + Ethereum off-ramp" feature
// announcement (2026-09 send to existing users). Deliberately its own
// file, not a generic template builder — see feedbackCampaign.ts's own
// comment for why: a one-off campaign's copy doesn't need to be reusable,
// and the next one is likely to look nothing like this one. No first-name
// personalization — confirmed live (2026-09-14) that this field isn't
// recorded anywhere for existing users, so a merge tag would just print
// blank/undefined for all 89 recipients instead of degrading gracefully;
// greeted generically ("Hi there 👋") instead, per the user's own exact
// copy — the one emoji deliberately kept after an earlier round of
// feedback asked for the rest stripped.
//
// Structure mirrors feedbackCampaign.ts's own proven shape (light #f4f2ee
// ground, white card, a short dark header bar, dark-on-white body copy) —
// an earlier full-bleed dark-green version read as a marketing graphic
// pasted into an email rather than an actual email (real feedback,
// 2026-09-14). Copy is the user's own exact wording, emoji stripped (a
// second round of feedback, same day) so it reads as written by a person,
// not generated — no icon chips or extra elements added beyond what was
// actually asked for.

export const NEW_WEEK_CAMPAIGN_KEY = "2026-09-new-week-usdt0-ethereum-v4";
export const NEW_WEEK_CAMPAIGN_SUBJECT = "Happy new week from CowryPay";
export const NEW_WEEK_CAMPAIGN_FROM = "CowryPay <hello@cowrypay.xyz>";

const APP_URL = "https://cowrypay.xyz";

export function buildNewWeekCampaignEmail(unsubscribeUrl: string): { html: string; text: string } {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f2ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f2ee;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#0e2a1a;padding:24px 32px;">
                <span style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:0.01em;">Cowry<span style="color:#3ddc84;">Pay</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0 0 20px 0;color:#12172b;font-size:16px;line-height:1.6;">Hi there &#128075;</p>
                <p style="margin:0 0 20px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  Happy new week. Hope you're starting it off strong.
                </p>
                <p style="margin:0 0 24px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  We've got some good news to kick things off — a couple of new things just landed on CowryPay that we think you'll love:
                </p>
                <p style="margin:0 0 8px 0;color:#12172b;font-size:16px;font-weight:700;">USDT0 on Stellar is here</p>
                <p style="margin:0 0 24px 0;color:#4a5068;font-size:15px;line-height:1.6;">
                  You can now hold, send, and cash out USDT0 right on Stellar — same speed and low fees you're used to, just more stablecoin options for you.
                </p>
                <p style="margin:0 0 8px 0;color:#12172b;font-size:16px;font-weight:700;">Ethereum is now supported for off-ramp</p>
                <p style="margin:0 0 28px 0;color:#4a5068;font-size:15px;line-height:1.6;">
                  Got USDC sitting on Ethereum? You can now cash it out straight to your bank or mobile money, no extra bridging needed. One less step between you and your money.
                </p>
                <p style="margin:0 0 28px 0;color:#12172b;font-size:16px;line-height:1.6;">
                  That's it for now — go make this week a good one, and don't forget your money's always ready when you need it.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px 0;">
                  <tr>
                    <td style="background-color:#1fa955;border-radius:8px;">
                      <a href="${APP_URL}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Open CowryPay</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;color:#12172b;font-size:15px;line-height:1.6;">The CowryPay Team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px 32px;border-top:1px solid #e7e3da;">
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

  const text = `Hi there 👋

Happy new week. Hope you're starting it off strong.

We've got some good news to kick things off — a couple of new things just landed on CowryPay that we think you'll love:

USDT0 on Stellar is here
You can now hold, send, and cash out USDT0 right on Stellar — same speed and low fees you're used to, just more stablecoin options for you.

Ethereum is now supported for off-ramp
Got USDC sitting on Ethereum? You can now cash it out straight to your bank or mobile money, no extra bridging needed. One less step between you and your money.

That's it for now — go make this week a good one, and don't forget your money's always ready when you need it.

Open CowryPay: ${APP_URL}

The CowryPay Team

---
You're receiving this because you have a CowryPay account. Unsubscribe: ${unsubscribeUrl}`;

  return { html, text };
}
