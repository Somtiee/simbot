/** True when the dashboard auto-generated this label instead of a real X handle. */
export function isPlaceholderXHandle(xHandle: string): boolean {
  const h = xHandle.trim();
  return /^@new_account_\d+$/i.test(h) || /^new_account_\d+$/i.test(h);
}

function normalizeHandle(raw: string): string | null {
  const s = raw.trim().replace(/^@+/, "");
  if (!s || s.length > 30) return null;
  if (!/^[\w_]{1,30}$/.test(s)) return null;
  return `@${s}`;
}

/** Walk Simcluster agent API JSON for something that looks like an X / Simcluster username. */
export function extractXHandleFromAgentPayload(data: unknown, depth = 0): string | null {
  if (depth > 10 || data == null) return null;
  if (typeof data === "string") {
    return normalizeHandle(data);
  }
  if (typeof data !== "object") return null;
  const o = data as Record<string, unknown>;

  const directKeys = [
    "twitterHandle",
    "twitterUsername",
    "xHandle",
    "xUsername",
    "x_handle",
    "twitter",
    "username",
    "handle",
  ];
  for (const k of directKeys) {
    const v = o[k];
    if (typeof v === "string") {
      const h = normalizeHandle(v);
      if (h) return h;
    }
  }

  const social = o.social;
  if (social && typeof social === "object") {
    const h = extractXHandleFromAgentPayload(social, depth + 1);
    if (h) return h;
  }

  for (const key of ["player", "character", "session", "user", "me", "profile", "data"]) {
    const nested = o[key];
    if (nested !== undefined) {
      const h = extractXHandleFromAgentPayload(nested, depth + 1);
      if (h) return h;
    }
  }
  return null;
}

const PROFILE_URLS = [
  "https://simcluster.ai/api/agent/delta/status",
  "https://simcluster.ai/api/agent/session",
  "https://simcluster.ai/api/agent/me",
];

/** Best-effort: resolve display @handle from a Simcluster agent bearer token. */
export async function fetchXHandleForAgentToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const headers = {
    Authorization: `Bearer ${trimmed}`,
    "X-Simcluster-Token": trimmed,
  };

  for (const url of PROFILE_URLS) {
    try {
      const response = await fetch(url, { headers, cache: "no-store" });
      if (!response.ok) continue;
      const data: unknown = await response.json().catch(() => null);
      const h = extractXHandleFromAgentPayload(data);
      if (h) return h;
    } catch {
      // try next URL
    }
  }
  return null;
}
