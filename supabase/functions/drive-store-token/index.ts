import { createAdminClient, requireUser } from "../_shared/auth.ts";
import { encryptRefreshToken } from "../_shared/crypto.ts";
import { errorResponse, jsonResponse, preflightResponse } from "../_shared/http.ts";

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return preflightResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, { error: "invalid_json" }, 400);
    }
    const refreshToken = body && typeof body === "object" && !Array.isArray(body) &&
      "refresh_token" in body && typeof body.refresh_token === "string"
      ? body.refresh_token
      : "";
    if (!refreshToken || refreshToken.length > 8192) {
      return jsonResponse(request, { error: "invalid_refresh_token" }, 400);
    }

    const encryptedToken = await encryptRefreshToken(refreshToken);
    const { error } = await createAdminClient()
      .from("vault_drive_credentials")
      .upsert({
        user_id: user.id,
        encrypted_refresh_token: encryptedToken,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
    if (error) throw error;

    return jsonResponse(request, { stored: true });
  } catch (error) {
    return errorResponse(request, error, "drive-store-token");
  }
});
