"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CookieShape = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

const GUIDE_STEPS = [
  "Open X in your browser and sign into the target account.",
  "Open DevTools, then Application tab, and inspect Cookies for `x.com`.",
  "Export values (`auth_token`, `ct0`, etc.) in Playwright cookie JSON format.",
  "Use “Re-export cookies” on an account card after each password reset/login challenge.",
];

export function CookieExporter() {
  const [rawCookies, setRawCookies] = useState("[]");
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(rawCookies) as CookieShape[];
      if (!Array.isArray(value)) return { cookies: [] as CookieShape[], parseError: "Cookies must be a JSON array." };
      return { cookies: value, parseError: "" };
    } catch {
      return { cookies: [] as CookieShape[], parseError: "Invalid JSON format." };
    }
  }, [rawCookies]);

  const simclusterValidity = useMemo(() => {
    if (parsed.parseError) return { valid: false, reason: parsed.parseError };
    if (parsed.cookies.length === 0) return { valid: false, reason: "No cookies supplied yet." };

    const hasDomainCookie = parsed.cookies.some((cookie) => {
      const domain = cookie.domain?.toLowerCase() ?? "";
      return domain.includes("simcluster.ai");
    });

    if (!hasDomainCookie) {
      return {
        valid: false,
        reason: "No cookie targets simcluster.ai. Re-export from a logged-in simcluster.ai session.",
      };
    }

    const hasSessionLikeCookie = parsed.cookies.some(
      (cookie) => Boolean(cookie.name) && Boolean(cookie.value) && (cookie.name!.includes("session") || cookie.name!.includes("auth")),
    );

    return {
      valid: true,
      reason: hasSessionLikeCookie
        ? "Cookies look valid for simcluster.ai."
        : "Domain is valid for simcluster.ai, but no obvious auth/session cookie found.",
    };
  }, [parsed]);

  const testLogin = async () => {
    if (!simclusterValidity.valid) {
      setResult({ ok: false, message: "Fix cookie validity issues first." });
      return;
    }

    setIsTesting(true);
    setResult(null);
    try {
      const response = await fetch("/api/cookies/test-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: parsed.cookies }),
      });
      const payload = (await response.json()) as { ok: boolean; message: string };
      setResult(payload);
    } catch {
      setResult({ ok: false, message: "Test login failed to execute." });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Card className="border border-cyan-500/30 bg-zinc-900/60">
      <CardHeader>
        <CardTitle className="text-base text-cyan-200">Cookie Exporter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-zinc-300">
          {GUIDE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-zinc-400">Cookie JSON</p>
          <textarea
            value={rawCookies}
            onChange={(event) => setRawCookies(event.target.value)}
            className="min-h-40 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-3 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-400"
            placeholder='[{"name":"session","value":"...","domain":".simcluster.ai","path":"/"}]'
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={
              simclusterValidity.valid
                ? "border border-lime-500/40 bg-lime-500/20 text-lime-200"
                : "border border-amber-500/40 bg-amber-500/20 text-amber-200"
            }
          >
            {simclusterValidity.valid ? "simcluster.ai cookie set detected" : "simcluster.ai cookie set missing"}
          </Badge>
          <span className="text-xs text-zinc-400">{simclusterValidity.reason}</span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={testLogin}
            disabled={isTesting || !simclusterValidity.valid}
            className="border border-lime-300/60 bg-lime-500/20 text-lime-100 hover:bg-lime-500/30"
          >
            <PlayCircle className="mr-2 size-4" />
            {isTesting ? "Testing Login..." : "Test Login"}
          </Button>
          {result ? (
            result.ok ? (
              <span className="inline-flex items-center text-xs text-lime-300">
                <CheckCircle2 className="mr-1 size-3.5" />
                {result.message}
              </span>
            ) : (
              <span className="inline-flex items-center text-xs text-amber-300">
                <AlertTriangle className="mr-1 size-3.5" />
                {result.message}
              </span>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
