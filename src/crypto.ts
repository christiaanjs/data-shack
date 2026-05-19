const HKDF_INFO = new TextEncoder().encode("data-shack-encryption");
const EMPTY_SALT = new Uint8Array(0);

function base64urlEncode(buf: Uint8Array): string {
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padding = (4 - (str.length % 4)) % 4;
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveEncryptionKey(jwtSecret: string): Promise<CryptoKey> {
  const rawKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(jwtSecret),
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: EMPTY_SALT, info: HKDF_INFO },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptConfig(plaintext: string, jwtSecret: string): Promise<string> {
  const key = await deriveEncryptionKey(jwtSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return base64urlEncode(combined);
}

export async function decryptConfig(ciphertext: string, jwtSecret: string): Promise<string> {
  const key = await deriveEncryptionKey(jwtSecret);
  const data = base64urlDecode(ciphertext);
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(plaintext);
}
