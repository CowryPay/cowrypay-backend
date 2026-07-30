import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // standard for GCM

function getKey(): Buffer {
  if (!env.recipientEncryptionKey) {
    throw new Error("RECIPIENT_ENCRYPTION_KEY must be set to save recipients");
  }
  // Derives a proper 32-byte key from whatever secret string is configured,
  // rather than requiring the operator to generate/paste exact raw bytes.
  return scryptSync(env.recipientEncryptionKey, "cowrypay-recipients", 32);
}

// Account numbers/phone numbers are sensitive PII even outside the KYC
// pipeline — stored as "iv:authTag:ciphertext" (all hex), never plain text.
export function encryptAccountIdentifier(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptAccountIdentifier(stored: string): string {
  const key = getKey();
  const [ivHex, authTagHex, cipherHex] = stored.split(":");
  if (!ivHex || !authTagHex || !cipherHex) {
    throw new Error("Malformed encrypted account identifier");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}
