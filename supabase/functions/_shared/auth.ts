import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import type { User } from "npm:@supabase/supabase-js@2.118.0";
import { HttpError } from "./http.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `missing_${name.toLowerCase()}`);
  return value;
}

function defaultKey(dictionaryName: string, legacyName: string): string {
  const dictionary = Deno.env.get(dictionaryName);
  if (dictionary) {
    let keys: unknown;
    try {
      keys = JSON.parse(dictionary);
    } catch {
      throw new HttpError(500, `invalid_${dictionaryName.toLowerCase()}`);
    }
    if (keys && typeof keys === "object" && "default" in keys && typeof keys.default === "string") {
      return keys.default;
    }
    throw new HttpError(500, `missing_default_${dictionaryName.toLowerCase()}`);
  }
  return requiredEnv(legacyName);
}

export async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized");
  }

  const supabase = createClient(
    requiredEnv("SUPABASE_URL"),
    defaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } }
    }
  );
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "unauthorized");
  return data.user;
}

export function createAdminClient() {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    defaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false }
    }
  );
}
