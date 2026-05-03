const EXCHANGE_URL = "https://simcluster.ai/api/agent/session/exchange-code";

/** Normalize pasted link codes (strip spaces, unify case for typical alphanumeric codes). */
export function normalizeAgentLinkCode(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "").replace(/[\u2013\u2014]/g, "-");
  if (/^[a-z0-9-]+$/i.test(trimmed) && !trimmed.includes("-")) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

/** Pull a session token from Simcluster exchange-code JSON (shape may evolve). */
export function extractSessionToken(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const keys = ["simclusterToken", "token", "accessToken", "bearerToken", "sessionToken", "bearer"];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 12) return v;
  }
  const session = o.session;
  if (session && typeof session === "object") {
    const s = session as Record<string, unknown>;
    for (const k of keys) {
      const v = s[k];
      if (typeof v === "string" && v.length > 12) return v;
    }
  }
  const nested = o.data;
  if (nested && typeof nested === "object") {
    const d = nested as Record<string, unknown>;
    for (const k of keys) {
      const v = d[k];
      if (typeof v === "string" && v.length > 12) return v;
    }
  }
  return null;
}

export type ExchangeResult =
  | { ok: true; token: string; raw: unknown }
  | { ok: false; message: string; status: number };

export async function exchangeAgentLinkCode(code: string): Promise<ExchangeResult> {
  const normalized = normalizeAgentLinkCode(code);
  const response = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalized }),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: "Invalid response from Simcluster.", status: response.status || 502 };
  }
  if (!response.ok) {
    let msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error?: string }).error)
        : typeof data === "object" && data && "message" in data
          ? String((data as { message?: string }).message)
          : `Simcluster returned ${response.status}`;
    if (/invalid or has expired/i.test(msg)) {
      msg +=
        " Generate a fresh code on simcluster.ai/agent/connect and paste it here immediately (codes are one-time and short-lived).";
    }
    return { ok: false, message: msg || "Exchange failed.", status: response.status };
  }
  const token = extractSessionToken(data);
  if (!token) {
    return { ok: false, message: "Connected, but no session token was found in the response.", status: 502 };
  }
  return { ok: true, token, raw: data };
}
