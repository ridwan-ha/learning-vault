import { createAdminClient, requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, preflightResponse } from "../_shared/http.ts";

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return preflightResponse(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(request);
    const { error } = await createAdminClient()
      .from("vault_drive_credentials")
      .delete()
      .eq("user_id", user.id);
    if (error) throw error;
    return jsonResponse(request, { disconnected: true });
  } catch (error) {
    return errorResponse(request, error, "drive-disconnect");
  }
});
