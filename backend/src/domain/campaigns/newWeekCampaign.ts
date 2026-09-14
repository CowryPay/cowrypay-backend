// Content + HTML for the "USDT0 on Stellar + Ethereum off-ramp" feature
// announcement (2026-09 send to existing users). Deliberately its own
// file, not a generic template builder — see feedbackCampaign.ts's own
// comment for why: a one-off campaign's copy doesn't need to be reusable,
// and the next one is likely to look nothing like this one. No first-name
// personalization — confirmed live (2026-09-14) that this field isn't
// recorded anywhere for existing users, so a merge tag would just print
// blank/undefined for all 89 recipients instead of degrading gracefully.

export const NEW_WEEK_CAMPAIGN_KEY = "2026-09-new-week-usdt0-ethereum";
export const NEW_WEEK_CAMPAIGN_SUBJECT = "Two new ways to move your money";
export const NEW_WEEK_CAMPAIGN_FROM = "CowryPay <hello@cowrypay.xyz>";

const APP_URL = "https://cowrypay.xyz";

export function buildNewWeekCampaignEmail(unsubscribeUrl: string): { html: string; text: string } {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:#081810;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
      USDT0 is live on Stellar, and Ethereum just joined off-ramp.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#081810;">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0E2A1A;border-radius:20px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:36px 40px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right:8px;">
                      <div style="width:22px;height:22px;background:#22C55E;border-radius:6px 6px 6px 0;"></div>
                    </td>
                    <td style="font-family:'Poppins',Arial,sans-serif;font-size:19px;font-weight:600;color:#F4F7F1;letter-spacing:-0.2px;">
                      Cowry<span style="color:#22C55E;">Pay</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 40px 4px;">
                <div style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;color:#5FBE86;text-transform:uppercase;">
                  Happy new week
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:10px 32px 6px;">
                <h1 style="margin:0;font-family:'Poppins',Arial,sans-serif;font-size:30px;line-height:1.25;font-weight:600;color:#F4F7F1;">
                  Two new ways to move your money
                </h1>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 44px 32px;">
                <p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#A9C7B4;">
                  We shipped two things last week that make CowryPay work for more of what you're holding, and more of where it needs to go.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px;">
                <div style="border-top:1px solid #1B4A2E;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="44" valign="top" style="padding-right:16px;">
                      <div style="width:44px;height:44px;border-radius:50%;background:#123420;text-align:center;line-height:44px;font-family:Arial,sans-serif;font-size:18px;font-weight:700;color:#26D07C;">
                        T&#8320;
                      </div>
                    </td>
                    <td valign="top">
                      <div style="font-family:'Poppins',Arial,sans-serif;font-size:17px;font-weight:600;color:#F4F7F1;padding-bottom:5px;">
                        USDT0 is live on Stellar
                      </div>
                      <div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14.5px;line-height:1.6;color:#A9C7B4;">
                        Hold it, send it, and cash it out on Stellar — same fees and speed you already know, one more stablecoin to work with.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="44" valign="top" style="padding-right:16px;">
                      <div style="width:44px;height:44px;border-radius:50%;background:#123420;text-align:center;line-height:44px;font-family:Arial,sans-serif;font-size:18px;font-weight:700;color:#26D07C;">
                        &#926;
                      </div>
                    </td>
                    <td valign="top">
                      <div style="font-family:'Poppins',Arial,sans-serif;font-size:17px;font-weight:600;color:#F4F7F1;padding-bottom:5px;">
                        Ethereum now off-ramps directly
                      </div>
                      <div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14.5px;line-height:1.6;color:#A9C7B4;">
                        USDC on Ethereum can go straight to a bank account or mobile money — no bridging to another chain first.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 40px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:0 4px 8px;">
                      <div style="font-family:Arial,sans-serif;font-size:12.5px;font-weight:600;color:#DCEFE3;background:#123420;border:1px solid #1B4A2E;border-radius:20px;padding:7px 14px;">NGN</div>
                    </td>
                    <td style="padding:0 4px 8px;">
                      <div style="font-family:Arial,sans-serif;font-size:12.5px;font-weight:600;color:#DCEFE3;background:#123420;border:1px solid #1B4A2E;border-radius:20px;padding:7px 14px;">KES</div>
                    </td>
                    <td style="padding:0 4px 8px;">
                      <div style="font-family:Arial,sans-serif;font-size:12.5px;font-weight:600;color:#DCEFE3;background:#123420;border:1px solid #1B4A2E;border-radius:20px;padding:7px 14px;">UGX</div>
                    </td>
                    <td style="padding:0 4px 8px;">
                      <div style="font-family:Arial,sans-serif;font-size:12.5px;font-weight:600;color:#DCEFE3;background:#123420;border:1px solid #1B4A2E;border-radius:20px;padding:7px 14px;">GHS</div>
                    </td>
                    <td style="padding:0 4px 8px;">
                      <div style="font-family:Arial,sans-serif;font-size:12.5px;font-weight:600;color:#DCEFE3;background:#123420;border:1px solid #1B4A2E;border-radius:20px;padding:7px 14px;">TZS</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 40px 40px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:12px;background:#22C55E;">
                      <a href="${APP_URL}" style="display:block;padding:14px 34px;font-family:'Poppins',Arial,sans-serif;font-size:15px;font-weight:600;color:#08210F;text-decoration:none;">
                        Open CowryPay
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 36px;border-top:1px solid #1B4A2E;">
                <p style="margin:0 0 6px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.6;color:#6E9280;">
                  Have a good week,<br />The CowryPay team
                </p>
                <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#4C6E5B;">
                  You're receiving this because you have a CowryPay account.
                  <a href="${unsubscribeUrl}" style="color:#6E9280;text-decoration:underline;">Unsubscribe</a>
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
