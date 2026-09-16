import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
import { Pool } from "pg";

// One-off diagnostic: prints a user's current kyc_status plus their recent
// KYC/AML history, so a real live verification result can be confirmed
// without needing separate Supabase dashboard access. Run the same way as
// scripts/migrate.ts (e.g. via Railway's Console): `npx tsx
// scripts/check-kyc-status.ts <email>`.
//
// Standalone on purpose, same reasoning as migrate.ts's own comment: only
// needs DATABASE_URL, not every other service's env vars config/env.ts
// would pull in.
setDefaultResultOrder("ipv4first");

const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npx tsx scripts/check-kyc-status.ts <email>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: true, ca: SUPABASE_ROOT_CA },
  });

  const { rows: users } = await pool.query(
    `select id, email, kyc_status, kyc_reference from users where email = $1`,
    [email],
  );
  const user = users[0];
  if (!user) {
    console.log(`No user found for email ${email}`);
    await pool.end();
    return;
  }

  console.log("User:", user);

  const { rows: attempts } = await pool.query(
    `select provider, provider_reference, status, resolved_at, created_at
     from kyc_verification_attempts where user_id = $1 order by created_at desc limit 5`,
    [user.id],
  );
  console.log("\nRecent KYC attempts:", attempts);

  const { rows: screenings } = await pool.query(
    `select status, match_status, risk_level, review_decision, error, created_at
     from aml_screenings where user_id = $1 order by created_at desc limit 5`,
    [user.id],
  );
  console.log("\nRecent AML sender screenings:", screenings);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
