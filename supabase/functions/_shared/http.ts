export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function corsHeaders(request: Request): Record<string, string> {
  const allowedOrigins = (Deno.env.get("APP_ORIGINS") || "https://ridwan-ha.github.io")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("Origin") || "";
  const defaultOrigin = allowedOrigins[0] || "https://ridwan-ha.github.io";
  const allowedOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : defaultOrigin;

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export function preflightResponse(request: Request): Response {
  return new Response("ok", { status: 204, headers: corsHeaders(request) });
}

export function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    }
  });
}

export function errorResponse(request: Request, error: unknown, operation: string): Response {
  if (error instanceof HttpError) {
    if (error.status >= 500) console.error(`${operation}: ${error.code}`);
    return jsonResponse(request, { error: error.code }, error.status);
  }
  console.error(`${operation} failed`, error);
  return jsonResponse(request, { error: "internal_error" }, 500);
}
