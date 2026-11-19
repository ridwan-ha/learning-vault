import { HttpError } from "./http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encryptionKey(): Uint8Array {
  const encoded = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY");
  if (!encoded) throw new HttpError(500, "missing_drive_token_encryption_key");

  let bytes: Uint8Array;
  try {
    const normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(500, "invalid_drive_token_encryption_key");
  }
  if (bytes.length !== 32) throw new HttpError(500, "invalid_drive_token_encryption_key");
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function getCryptoKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(encryptionKey()), { name: "AES-GCM" }, false, usages);
}

export async function encryptRefreshToken(refreshToken: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getCryptoKey(["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(refreshToken))
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(encrypted))}`;
}

export async function decryptRefreshToken(value: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 2) throw new HttpError(500, "invalid_encrypted_drive_token");

  try {
    const key = await getCryptoKey(["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(decodeBase64(parts[0])) },
      key,
      toArrayBuffer(decodeBase64(parts[1]))
    );
    return decoder.decode(decrypted);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "could_not_decrypt_drive_token");
  }
}
