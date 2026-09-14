// Content + HTML for the "USDT0 on Stellar + Ethereum off-ramp" feature
// announcement (2026-09 send to existing users). Deliberately its own
// file, not a generic template builder — see feedbackCampaign.ts's own
// comment for why: a one-off campaign's copy doesn't need to be reusable,
// and the next one is likely to look nothing like this one. No first-name
// personalization — confirmed live (2026-09-14) that this field isn't
// recorded anywhere for existing users, so a merge tag would just print
// blank/undefined for all 89 recipients instead of degrading gracefully.
//
// Structure and palette deliberately mirror feedbackCampaign.ts's own
// proven shape (light #f4f2ee ground, white card, a short dark header bar,
// dark-on-white body copy) — a first version of this went out full-bleed
// dark green on dark, and read as a marketing graphic pasted into an
// email rather than an actual email (real feedback, 2026-09-14). This is
// the same structural choice already sent once successfully, just with
// CowryPay's own green instead of the earlier gold accent.

export const NEW_WEEK_CAMPAIGN_KEY = "2026-09-new-week-usdt0-ethereum-v2";
export const NEW_WEEK_CAMPAIGN_SUBJECT = "Two new ways to move your money";
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
              <td style="padding:32px 32px 4px 32px;">
                <p style="margin:0 0 6px 0;color:#5b8a6d;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Happy new week</p>
                <h1 style="margin:0 0 14px 0;color:#12172b;font-size:23px;line-height:1.35;font-weight:700;">Two new ways to move your money</h1>
                <p style="margin:0 0 24px 0;color:#4a5068;font-size:15px;line-height:1.6;">
                  We shipped two things last week that make CowryPay work for more of what you're holding, and more of where it needs to go.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <hr style="border:none;border-top:1px solid #e7e3da;margin:0;" />
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="40" valign="top" style="padding-right:14px;padding-bottom:20px;">
                      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border-radius:50%;background-color:#e5f5ea;color:#0e6b3a;font-size:14px;font-weight:700;font-family:Arial,sans-serif;">T&#8320;</td></tr></table>
                    </td>
                    <td valign="top" style="padding-bottom:20px;">
                      <p style="margin:0 0 4px 0;color:#12172b;font-size:16px;font-weight:700;">USDT0 is live on Stellar</p>
                      <p style="margin:0;color:#4a5068;font-size:14.5px;line-height:1.6;">
                        Hold it, send it, and cash it out on Stellar — same fees and speed you already know, one more stablecoin to work with.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td width="40" valign="top" style="padding-right:14px;">
                      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border-radius:50%;background-color:#e5f5ea;color:#0e6b3a;font-size:16px;font-weight:700;font-family:Arial,sans-serif;">&#926;</td></tr></table>
                    </td>
                    <td valign="top">
                      <p style="margin:0 0 4px 0;color:#12172b;font-size:16px;font-weight:700;">Ethereum now off-ramps directly</p>
                      <p style="margin:0;color:#4a5068;font-size:14.5px;line-height:1.6;">
                        USDC on Ethereum can go straight to a bank account or mobile money — no bridging to another chain first.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 32px 28px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:0 6px 8px 0;"><span style="display:inline-block;font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#3a5c47;background-color:#eef6f0;border:1px solid #dde8e0;border-radius:20px;padding:5px 12px;">NGN</span></td>
                    <td style="padding:0 6px 8px 0;"><span style="display:inline-block;font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#3a5c47;background-color:#eef6f0;border:1px solid #dde8e0;border-radius:20px;padding:5px 12px;">KES</span></td>
                    <td style="padding:0 6px 8px 0;"><span style="display:inline-block;font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#3a5c47;background-color:#eef6f0;border:1px solid #dde8e0;border-radius:20px;padding:5px 12px;">UGX</span></td>
                    <td style="padding:0 6px 8px 0;"><span style="display:inline-block;font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#3a5c47;background-color:#eef6f0;border:1px solid #dde8e0;border-radius:20px;padding:5px 12px;">GHS</span></td>
                    <td style="padding:0 0 8px 0;"><span style="display:inline-block;font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#3a5c47;background-color:#eef6f0;border:1px solid #dde8e0;border-radius:20px;padding:5px 12px;">TZS</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background-color:#1fa955;border-radius:8px;">
                      <a href="${APP_URL}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Open CowryPay</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <p style="margin:0;color:#12172b;font-size:14px;line-height:1.6;">Have a good week,<br />The CowryPay team</p>
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

  const text = `Happy new week.

Two things shipped last week that make CowryPay work for more of what you're holding, and more of where it needs to go:

USDT0 is live on Stellar
Hold it, send it, and cash it out on Stellar — same fees and speed you already know, one more stablecoin to work with.

Ethereum now off-ramps directly
USDC on Ethereum can go straight to a bank account or mobile money — no bridging to another chain first.

Supported payout currencies: NGN, KES, UGX, GHS, TZS.

Open CowryPay: ${APP_URL}

Have a good week,
The CowryPay team

---
You're receiving this because you have a CowryPay account. Unsubscribe: ${unsubscribeUrl}`;

  return { html, text };
}
