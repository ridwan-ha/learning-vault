import { decryptRefreshToken, encryptRefreshToken } from "./crypto.ts";

Deno.test("refresh tokens are encrypted and tampering is rejected", async () => {
  const previousKey = Deno.env.get("DRIVE_TOKEN_ENCRYPTION_KEY");
  const testKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
  Deno.env.set("DRIVE_TOKEN_ENCRYPTION_KEY", testKey);

  try {
    const refreshToken = "test-google-refresh-token";
    const encrypted = await encryptRefreshToken(refreshToken);
    if (encrypted === refreshToken) throw new Error("The refresh token was not encrypted.");
    if (await decryptRefreshToken(encrypted) !== refreshToken) {
      throw new Error("The encrypted refresh token did not round-trip.");
    }

    const [iv, ciphertext] = encrypted.split(".");
    const replacement = ciphertext[0] === "A" ? "B" : "A";
    let rejectedTamperedToken = false;
    try {
      await decryptRefreshToken(`${iv}.${replacement}${ciphertext.slice(1)}`);
    } catch {
      rejectedTamperedToken = true;
    }
    if (!rejectedTamperedToken) throw new Error("Tampered ciphertext was accepted.");
  } finally {
    if (previousKey === undefined) Deno.env.delete("DRIVE_TOKEN_ENCRYPTION_KEY");
    else Deno.env.set("DRIVE_TOKEN_ENCRYPTION_KEY", previousKey);
  }
});
