import { createAdminClient, requireUser } from "../_shared/auth.ts";
import { decryptRefreshToken, encryptRefreshToken } from "../_shared/crypto.ts";
import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `missing_${name.toLowerCase()}`);
  return value;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return preflightResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(request);
    const admin = createAdminClient();
    const { data, error } = await admin.from("vault_drive_credentials")
      .select("encrypted_refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "drive_not_linked");

    const refreshToken = await decryptRefreshToken(data.encrypted_refresh_token);
    const googleResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: requiredEnv("DRIVE_CLIENT_ID"),
        client_secret: requiredEnv("DRIVE_CLIENT_SECRET"),
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      })
    });
    const result = await googleResponse.json();
    if (!googleResponse.ok) {
      if (result.error === "invalid_grant") {
        const { error: deleteError } = await admin.from("vault_drive_credentials").delete().eq("user_id", user.id);
        if (deleteError) throw deleteError;
        throw new HttpError(409, "drive_reconnect_required");
      }
      console.error("Google token refresh failed", result.error || googleResponse.status);
      throw new HttpError(502, "google_token_refresh_failed");
    }

    if (typeof result.access_token !== "string" || !result.access_token) {
      throw new HttpError(502, "google_access_token_missing");
    }
    const expiresIn = Number(result.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new HttpError(502, "google_token_expiry_invalid");
    }
    if (typeof result.refresh_token === "string" && result.refresh_token) {
      const encryptedToken = await encryptRefreshToken(result.refresh_token);
      const { error: updateError } = await admin.from("vault_drive_credentials")
        .update({ encrypted_refresh_token: encryptedToken, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      if (updateError) throw updateError;
    }

    return jsonResponse(request, {
      access_token: result.access_token,
      expires_in: expiresIn,
      email: user.email || ""
    });
  } catch (error) {
    return errorResponse(request, error, "drive-token");
  }
});
