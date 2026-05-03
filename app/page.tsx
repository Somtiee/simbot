"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Cookie,
  Download,
  ExternalLink,
  Link2,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useFarmStore } from "@/lib/store";
import type { SimclusterAccount } from "@/types";
import { toast } from "sonner";

type LogEntry = { text: string; tone: "success" | "warn" | "info" };
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

type FarmStatus = {
  running: boolean;
  totalAccounts: number;
  completedAccounts: number;
  currentAccountProgress: number;
  overallProgress: number;
  currentAccountHandle?: string;
  nextFarmAt?: string;
  successMessage?: string;
  logs: Array<{ ts: string; text: string; tone: "success" | "warn" | "info" }>;
  accounts?: SimclusterAccount[];
};

type ConnectStatus = {
  state: "idle" | "running" | "connected" | "failed";
  message: string;
  startedAt?: string;
  finishedAt?: string;
  profilePath?: string;
  profileDirectory?: string;
};

const statusTone: Record<string, string> = {
  farming: "text-lime-300",
  completed: "text-cyan-300",
  idle: "text-zinc-300",
  error: "text-rose-300",
};

const progressFromAccount = (account: SimclusterAccount) => {
  if (account.status === "completed") return 100;
  if (account.status === "error") return 22;
  if (typeof account.cloutEstimate === "number") {
    return Math.max(15, Math.min(99, account.cloutEstimate % 101));
  }
  return account.status === "farming" ? 68 : 40;
};

export default function Home() {
  const accounts = useFarmStore((state) => state.accounts);
  const addAccount = useFarmStore((state) => state.addAccount);
  const removeAccount = useFarmStore((state) => state.removeAccount);
  const updateAccount = useFarmStore((state) => state.updateAccount);
  const setAccounts = useFarmStore((state) => state.setAccounts);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [farmStatus, setFarmStatus] = useState<FarmStatus>({
    running: false,
    totalAccounts: 0,
    completedAccounts: 0,
    currentAccountProgress: 0,
    overallProgress: 0,
    logs: [],
  });
  const [cooldownNow, setCooldownNow] = useState(() => Date.now());

  const [headedMode, setHeadedMode] = useState(false);
  const [randomizeOrder, setRandomizeOrder] = useState(true);
  const [enableImageGeneration, setEnableImageGeneration] = useState(true);
  const [safeRotation, setSafeRotation] = useState(true);
  const [crashModalTask, setCrashModalTask] = useState<string | null>(null);
  const [cookieModalAccountId, setCookieModalAccountId] = useState<string | null>(null);
  const [cookieJson, setCookieJson] = useState("[]");
  const [cookieValidation, setCookieValidation] = useState<{ ok: boolean; message: string } | null>(null);
  const [isCookieTesting, setIsCookieTesting] = useState(false);
  const [connectModalAccountId, setConnectModalAccountId] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState("C:\\Users\\<YOU>\\AppData\\Local\\Google\\Chrome\\User Data");
  const [profileDirectory, setProfileDirectory] = useState("Default");
  const [connectBrowser, setConnectBrowser] = useState<"chrome" | "edge">("chrome");
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [isConnectStarting, setIsConnectStarting] = useState(false);
  const [connectLinkCode, setConnectLinkCode] = useState("");
  const [isExchangingLink, setIsExchangingLink] = useState(false);
  const [connectExchangeError, setConnectExchangeError] = useState<string | null>(null);
  const [connectInteractiveAvailable, setConnectInteractiveAvailable] = useState(true);
  const [forceHeadless, setForceHeadless] = useState(false);
  const connectedCount = accounts.length;
  const farmingCount = accounts.filter((account) => account.status === "farming").length;

  const startFarmRun = useCallback(async () => {
    const headed = forceHeadless ? false : headedMode;
    try {
      const response = await fetch("/api/farm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headed }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        started?: boolean;
        message?: string;
      };
      if (response.status === 409 || payload.started === false) {
        toast.error(payload.message ?? "Farm did not start (already running or blocked).");
        return;
      }
      if (!response.ok) {
        toast.error(payload.message ?? "Unable to start farm run.");
        return;
      }
      toast.success(`Agent farm started for ${connectedCount} account(s). Watch the Live Agent Log.`);
    } catch {
      toast.error("Network error — could not reach the server.");
    }
  }, [connectedCount, headedMode, forceHeadless]);

  useEffect(() => {
    const poll = async () => {
      const response = await fetch("/api/farm/status", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as FarmStatus;
      setFarmStatus(payload);
      setLogs((payload.logs ?? []).slice(-12).map((item) => ({ text: item.text, tone: item.tone })));
      const crashLine = [...(payload.logs ?? [])]
        .reverse()
        .find(
          (item) =>
            item.tone === "warn" &&
            (/farm stopped:/i.test(item.text) || /moved to next account/i.test(item.text)),
        );
      if (crashLine && !payload.running) {
        setCrashModalTask(crashLine.text);
      }
      if (Array.isArray(payload.accounts) && payload.accounts.length > 0) {
        setAccounts(payload.accounts);
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
      setCooldownNow(Date.now());
    }, 2500);

    return () => clearInterval(timer);
  }, [setAccounts]);

  useEffect(() => {
    void fetch("/api/runtime", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { connectInteractiveAvailable?: boolean; forceHeadless?: boolean }) => {
        if (typeof body.connectInteractiveAvailable === "boolean") {
          setConnectInteractiveAvailable(body.connectInteractiveAvailable);
        }
        if (body.forceHeadless) {
          setForceHeadless(true);
          setHeadedMode(false);
        }
      })
      .catch(() => {
        /* keep default true for local dev */
      });
  }, []);

  const nextFarmMs = farmStatus.nextFarmAt ? new Date(farmStatus.nextFarmAt).getTime() - cooldownNow : 0;
  const isCooldownActive = nextFarmMs > 0;
  const countdownLabel = useMemo(() => {
    if (!isCooldownActive) return "";
    const totalSeconds = Math.max(0, Math.floor(nextFarmMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  }, [isCooldownActive, nextFarmMs]);
  const buttonDisabled = farmStatus.running || isCooldownActive;
  const buttonBlockReason = farmStatus.running
    ? "A run is in progress (or the lock is stuck — use Clear farm lock)."
    : isCooldownActive
      ? `Cooldown active — ${countdownLabel}`
      : "";

  const orderedAccounts = useMemo(() => {
    if (!randomizeOrder) return accounts;
    return [...accounts].sort((a, b) => progressFromAccount(b) - progressFromAccount(a));
  }, [accounts, randomizeOrder]);
  const cookieModalAccount = useMemo(
    () => accounts.find((account) => account.id === cookieModalAccountId) ?? null,
    [accounts, cookieModalAccountId],
  );
  const connectModalAccount = useMemo(
    () => accounts.find((account) => account.id === connectModalAccountId) ?? null,
    [accounts, connectModalAccountId],
  );

  const parsedCookiePayload = useMemo(() => {
    try {
      const parsed = JSON.parse(cookieJson) as CookieShape[];
      if (!Array.isArray(parsed)) return { cookies: [] as CookieShape[], error: "Cookies must be a JSON array." };
      return { cookies: parsed, error: "" };
    } catch {
      return { cookies: [] as CookieShape[], error: "Invalid JSON format." };
    }
  }, [cookieJson]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (!buttonDisabled) {
          void startFarmRun();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buttonDisabled, startFarmRun]);

  useEffect(() => {
    if (!connectModalAccountId) return;

    const poll = async () => {
      const response = await fetch(
        `/api/accounts/connect/status?accountId=${encodeURIComponent(connectModalAccountId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { ok: boolean; status: ConnectStatus };
      if (!payload.ok) return;
      setConnectStatus(payload.status);
      if (payload.status.state === "connected") {
        const accountsResponse = await fetch("/api/accounts", { cache: "no-store" });
        if (accountsResponse.ok) {
          const refreshed = (await accountsResponse.json()) as SimclusterAccount[];
          setAccounts(refreshed);
        }
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => clearInterval(timer);
  }, [connectModalAccountId, setAccounts]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-lime-500/20 bg-zinc-950/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bot className="size-5 text-lime-400" />
            <h1 className="text-lg font-semibold tracking-wide">
              Simcluster Agent Farmer • {connectedCount} Accounts
            </h1>
            <Badge className="border border-lime-400/50 bg-lime-500/20 text-lime-200">
              Invite-Only Alpha
            </Badge>
            <Badge className="border border-fuchsia-500/40 bg-fuchsia-500/20 text-fuchsia-200">
              Agent Intelligence v2
            </Badge>
          </div>
          <Badge variant="secondary" className="border border-cyan-400/50 bg-cyan-500/15 text-cyan-200">
            {connectedCount} accounts
          </Badge>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-73px)] lg:grid-cols-[340px_1fr]">
        <aside className="flex max-h-[calc(100vh-73px)] flex-col border-r border-lime-500/20 bg-zinc-900/50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-300">Account Cluster</h2>
            <Badge className="bg-lime-500/20 text-lime-200">{orderedAccounts.length} live</Badge>
          </div>
          <div className="space-y-3 overflow-y-auto pr-1">
            {orderedAccounts.map((account) => (
              <Card key={account.id} className="border border-lime-500/20 bg-zinc-900/70">
                <CardContent className="space-y-3 p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium" title={account.xHandle}>
                      {account.xHandle.startsWith("@") ? account.xHandle : `@${account.xHandle}`}
                    </p>
                    <div
                      className="grid size-9 place-items-center rounded-full border border-lime-500/30 text-[10px] font-semibold"
                      style={{
                        background: `conic-gradient(#84cc16 ${progressFromAccount(account) * 3.6}deg, #27272a 0deg)`,
                      }}
                    >
                      <span className="grid size-7 place-items-center rounded-full bg-zinc-950">
                        {progressFromAccount(account)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className={`${statusTone[account.status]} capitalize`}>{account.status}</span>
                    <span className="text-zinc-400">Last farmed {account.lastFarmed ?? "never"}</span>
                  </div>
                  <div className="text-[11px]">
                    {(Array.isArray(account.cookies) && account.cookies.length > 0) ||
                    (typeof account.agentSessionToken === "string" && account.agentSessionToken.length > 0) ? (
                      <span className="text-lime-300">Session: Connected</span>
                    ) : (
                      <span className="text-amber-300">Session: Not connected</span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-cyan-500/40 text-xs text-cyan-200"
                      title="Link this row to Simcluster using a short code from simcluster.ai/agent/connect (works on Railway and your PC)."
                      onClick={() => {
                        setConnectModalAccountId(account.id);
                        setConnectStatus(null);
                        setConnectLinkCode("");
                        setConnectExchangeError(null);
                      }}
                    >
                      <Link2 className="mr-1 size-3" />
                      Connect Account
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-lime-500/40 text-xs"
                      onClick={() => {
                        setCookieModalAccountId(account.id);
                        setCookieJson(JSON.stringify(account.cookies ?? [], null, 2));
                        setCookieValidation(null);
                      }}
                    >
                      <Cookie className="mr-1 size-3" />
                      Cookies
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${account.xHandle} from the cluster? This deletes it from the server list after save.`,
                          )
                        ) {
                          return;
                        }
                        removeAccount(account.id);
                        toast.success(`Removed ${account.xHandle}`);
                      }}
                    >
                      <Trash2 className="mr-1 size-3" />
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-cyan-200">
                      <ExternalLink className="mr-1 size-3" />
                      View last post
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Button
            variant="outline"
            className="mt-3 border-lime-500/40 bg-zinc-950/70 text-lime-200 hover:bg-lime-500/10"
            onClick={() => {
              const nextNumber = connectedCount + 1;
              addAccount({
                id: `acct-${Date.now()}`,
                xHandle: `@new_account_${nextNumber}`,
                cookies: [],
                status: "idle",
                lastFarmed: "never",
                cloutEstimate: 0,
              });
              toast.success(`Account ${nextNumber} added`);
            }}
          >
            <Plus className="mr-2 size-4" />
            Add New Account
          </Button>
        </aside>

        <main className="space-y-5 p-6">
          {!farmStatus.running && farmStatus.successMessage ? (
            <Card className="border border-lime-400/50 bg-lime-500/10 shadow-[0_0_40px_rgba(132,204,22,0.25)]">
              <CardContent className="p-6 text-center">
                <p className="text-lg font-semibold text-lime-200">
                  ✅ AGENT FARM COMPLETE — ALL {connectedCount} ACCOUNTS AT MAX DAILY CLOUT + NEW AI POSTS & IMAGES
                  GENERATED
                </p>
                {isCooldownActive ? (
                  <p className="mt-2 text-sm text-lime-100">Next farm available in {countdownLabel}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card className="border border-lime-500/25 bg-zinc-900/60">
            <CardContent className="p-6">
              <Button
                className="h-20 w-full border border-lime-300/60 bg-lime-500/20 text-base font-semibold text-lime-100 shadow-[0_0_40px_rgba(132,204,22,0.35)] hover:bg-lime-500/30 disabled:opacity-50"
                disabled={buttonDisabled}
                title={buttonDisabled ? buttonBlockReason : "Start a farm run on the server"}
                onClick={() => void startFarmRun()}
              >
                <Sparkles className="mr-2 size-5" />
                {farmStatus.running
                  ? "🚀 AGENT FARM RUNNING..."
                  : "🚀 ACTIVATE AGENT FARM — MAX CLOUT FOR ALL CONNECTED ACCOUNTS"}
              </Button>
              <p className="mt-3 text-center text-sm text-zinc-300">
                Farming {farmingCount} of {connectedCount} accounts
              </p>
              {isCooldownActive && !farmStatus.running ? (
                <p className="mt-2 text-center text-xs text-amber-300">Next farm available in {countdownLabel}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-amber-200 hover:bg-amber-500/10 hover:text-amber-100"
                  onClick={async () => {
                    try {
                      const r = await fetch("/api/farm/unlock", { method: "POST" });
                      const p = (await r.json().catch(() => ({}))) as { ok?: boolean };
                      if (r.ok && p.ok) {
                        toast.success("Farm lock cleared. Try Activate again.");
                      } else {
                        toast.error("Could not clear lock.");
                      }
                    } catch {
                      toast.error("Network error.");
                    }
                  }}
                >
                  Clear farm lock (stuck button / zombie run)
                </Button>
                {forceHeadless ? (
                  <span className="text-zinc-500">Headed mode is off on cloud (Railway).</span>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-lime-500/25 bg-zinc-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Agent Runtime Progress</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-zinc-300">
                  <span>
                    Current account {farmStatus.currentAccountHandle ? `(${farmStatus.currentAccountHandle})` : ""}
                  </span>
                  <span>{farmStatus.currentAccountProgress}%</span>
                </div>
                <Progress value={farmStatus.currentAccountProgress} />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-zinc-300">
                  <span>
                    Overall progress ({farmStatus.completedAccounts}/{farmStatus.totalAccounts || connectedCount}{" "}
                    accounts)
                  </span>
                  <span>{farmStatus.overallProgress}%</span>
                </div>
                <Progress value={farmStatus.overallProgress} />
              </div>
            </CardContent>
          </Card>

          <Card className="border border-cyan-500/30 bg-zinc-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Radio className="size-4 text-cyan-300" />
                Live Agent Log
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 font-mono text-sm">
              {logs.length === 0 ? (
                <p className="text-zinc-500">Waiting for live agent events...</p>
              ) : (
                logs.map((entry, index) => (
                <p
                  key={`${entry.text}-${index}`}
                  className={
                    entry.tone === "success"
                      ? "text-lime-300"
                      : entry.tone === "warn"
                        ? "text-amber-300"
                        : "text-cyan-300"
                  }
                >
                  {entry.text}
                </p>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border border-lime-500/20 bg-zinc-900/60">
            <CardHeader>
              <CardTitle className="text-base">Agent Runtime Toggles</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
                <span className="text-sm">Headed mode {forceHeadless ? "(cloud: off)" : ""}</span>
                <Switch
                  checked={forceHeadless ? false : headedMode}
                  disabled={forceHeadless}
                  onCheckedChange={forceHeadless ? undefined : setHeadedMode}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
                <span className="text-sm">Randomize order</span>
                <Switch checked={randomizeOrder} onCheckedChange={setRandomizeOrder} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
                <span className="text-sm">Enable Image Generation</span>
                <Switch checked={enableImageGeneration} onCheckedChange={setEnableImageGeneration} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
                <span className="text-sm">Safe Cross-Account Rotation</span>
                <Switch checked={safeRotation} onCheckedChange={setSafeRotation} />
              </div>
              <Button
                variant="outline"
                className="border-cyan-500/40 bg-zinc-950/60 text-cyan-200 hover:bg-cyan-500/10"
                onClick={async () => {
                  const response = await fetch("/api/config/export");
                  if (!response.ok) {
                    toast.error("Backup export failed.");
                    return;
                  }
                  const payload = (await response.json()) as unknown;
                  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `simcluster-backup-${new Date().toISOString().slice(0, 10)}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                  toast.success("Backup exported.");
                }}
              >
                <Download className="mr-2 size-4" />
                Full Backup / Export Config
              </Button>
            </CardContent>
          </Card>

          <details className="rounded-lg border border-cyan-500/30 bg-zinc-900/60 p-4">
            <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-200">
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="size-4" />
                Agent Intelligence Explained
              </span>
            </summary>
            <div className="mt-4 space-y-4 text-sm text-zinc-300">
              <p>
                The agent prioritizes daily check-ins, rotates premium tasks by seed, and enforces cooldown windows to
                reduce account-linking risk while maximizing clout cadence.
              </p>
              <div className="rounded-md border border-zinc-700 bg-zinc-950/70 p-3">
                <p className="mb-2 font-medium text-zinc-100">Cookie export guide</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Open X in your browser and sign into the target account.</li>
                  <li>Open DevTools, then Application tab, and inspect Cookies for `x.com`.</li>
                  <li>Export values (`auth_token`, `ct0`, etc.) in Playwright cookie JSON format.</li>
                  <li>Use the “Cookies” button on an account card after each password reset or login challenge.</li>
                </ol>
              </div>
            </div>
          </details>
        </main>
      </div>
      {crashModalTask ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-xl rounded-lg border border-rose-500/40 bg-zinc-900 p-5">
            <h3 className="text-lg font-semibold text-rose-200">Farm stopped on an account</h3>
            <p className="mt-2 text-sm text-zinc-400">
              Usually a bad or expired session, a timeout, or Simcluster layout changed. Check the Live Agent Log for
              the full line below.
            </p>
            <p className="mt-3 rounded-md border border-zinc-700 bg-zinc-950/80 p-2 font-mono text-xs text-zinc-200">
              {crashModalTask}
            </p>
            <div className="mt-4 flex gap-2">
              <Button
                onClick={() => {
                  setCrashModalTask(null);
                  void startFarmRun();
                }}
              >
                Retry Farm
              </Button>
              <Button variant="outline" onClick={() => setCrashModalTask(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {connectModalAccount ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-cyan-500/40 bg-zinc-900 p-5">
            <h3 className="text-lg font-semibold text-cyan-200">Connect Simcluster Account</h3>
            <p className="mt-1 text-sm text-zinc-300">
              Account: <span className="font-medium text-zinc-100">{connectModalAccount.xHandle}</span>
            </p>

            <div className="mt-4 rounded-md border border-lime-500/30 bg-lime-500/10 p-3">
              <p className="text-sm font-medium text-lime-100">Link with a short code (recommended)</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-zinc-300">
                <li>Open Simcluster’s connect page in a new tab and sign in.</li>
                <li>Copy the one-time code it shows (each code works once and expires quickly).</li>
                <li>Paste it below right away, then press Connect with code — if it fails, generate a new code and try again.</li>
              </ol>
              <a
                href="https://simcluster.ai/agent/connect"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/25"
              >
                Open simcluster.ai/agent/connect
              </a>
              <label className="mt-3 block text-xs text-zinc-300">
                One-time code
                <input
                  value={connectLinkCode}
                  onChange={(event) => {
                    setConnectLinkCode(event.target.value);
                    setConnectExchangeError(null);
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-2 font-mono text-sm text-zinc-100 outline-none focus:border-cyan-400"
                  placeholder="Paste the code from Simcluster"
                  autoComplete="off"
                />
              </label>
              {connectExchangeError ? (
                <p className="mt-2 text-xs text-rose-300">{connectExchangeError}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={isExchangingLink || !connectLinkCode.trim()}
                  onClick={async () => {
                    setIsExchangingLink(true);
                    setConnectExchangeError(null);
                    try {
                      const response = await fetch("/api/accounts/connect/exchange-code", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          accountId: connectModalAccount.id,
                          xHandle: connectModalAccount.xHandle,
                          code: connectLinkCode.trim(),
                        }),
                      });
                      const payload = (await response.json()) as { ok?: boolean; message?: string };
                      if (!response.ok || !payload.ok) {
                        setConnectExchangeError(payload.message ?? "Could not link this code.");
                        return;
                      }
                      const refresh = await fetch("/api/accounts", { cache: "no-store" });
                      if (refresh.ok) {
                        const list = (await refresh.json()) as SimclusterAccount[];
                        setAccounts(list);
                      }
                      toast.success(payload.message ?? "Account linked.");
                      setConnectModalAccountId(null);
                      setConnectLinkCode("");
                    } catch {
                      setConnectExchangeError("Something went wrong. Try again.");
                    } finally {
                      setIsExchangingLink(false);
                    }
                  }}
                >
                  {isExchangingLink ? "Connecting…" : "Connect with code"}
                </Button>
              </div>
            </div>

            <details className="mt-5 rounded-md border border-zinc-700 bg-zinc-950/50 p-3">
              <summary className="cursor-pointer text-xs font-medium text-zinc-400">
                Advanced — Chrome profile (only if this app runs on your own Windows/Mac)
              </summary>
              {!connectInteractiveAvailable ? (
                <p className="mt-2 text-xs text-amber-200">
                  Hidden Chrome launch is not available on cloud hosting. Use the link code above, or the Cookies
                  button for manual cookie JSON.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-zinc-400">
                    Launches Chrome/Edge on the same computer that is running the farmer app. Close that browser
                    profile first.
                  </p>
                  <label className="text-xs text-zinc-300">
                    Browser
                    <select
                      value={connectBrowser}
                      onChange={(event) => setConnectBrowser(event.target.value as "chrome" | "edge")}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-2 text-xs text-zinc-100 outline-none focus:border-cyan-400"
                    >
                      <option value="chrome">Google Chrome</option>
                      <option value="edge">Microsoft Edge</option>
                    </select>
                  </label>
                  <label className="text-xs text-zinc-300">
                    User Data path
                    <input
                      value={profilePath}
                      onChange={(event) => setProfilePath(event.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-2 text-xs text-zinc-100 outline-none focus:border-cyan-400"
                    />
                  </label>
                  <label className="text-xs text-zinc-300">
                    Profile directory (Default, Profile 1, …)
                    <input
                      value={profileDirectory}
                      onChange={(event) => setProfileDirectory(event.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-2 text-xs text-zinc-100 outline-none focus:border-cyan-400"
                    />
                  </label>
                  {connectStatus ? (
                    <p
                      className={`text-xs ${
                        connectStatus.state === "connected"
                          ? "text-lime-300"
                          : connectStatus.state === "failed"
                            ? "text-rose-300"
                            : "text-cyan-300"
                      }`}
                    >
                      {connectStatus.message}
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={isConnectStarting || !profilePath.trim()}
                    onClick={async () => {
                      setIsConnectStarting(true);
                      try {
                        const response = await fetch("/api/accounts/connect/start", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            accountId: connectModalAccount.id,
                            xHandle: connectModalAccount.xHandle,
                            profilePath: profilePath.trim(),
                            profileDirectory: profileDirectory.trim() || "Default",
                            browser: connectBrowser,
                            interactive: true,
                          }),
                        });
                        if (!response.ok) {
                          toast.error("Could not start connect flow.");
                        } else {
                          toast.success("Connect flow started. Complete login in the opened window.");
                        }
                      } finally {
                        setIsConnectStarting(false);
                      }
                    }}
                  >
                    {isConnectStarting ? "Starting…" : "Launch Chrome profile"}
                  </Button>
                </div>
              )}
            </details>

            <div className="mt-4 flex justify-end">
              <Button variant="outline" onClick={() => setConnectModalAccountId(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {cookieModalAccount ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-cyan-500/40 bg-zinc-900 p-5">
            <h3 className="text-lg font-semibold text-cyan-200">Account Cookie Onboarding</h3>
            <p className="mt-1 text-sm text-zinc-300">
              Target account: <span className="font-medium text-zinc-100">{cookieModalAccount.xHandle}</span>
            </p>
            <p className="mt-2 text-xs text-zinc-400">
              Paste Playwright cookie JSON, run Test Login, then Save to this account.
            </p>

            <textarea
              value={cookieJson}
              onChange={(event) => {
                setCookieJson(event.target.value);
                setCookieValidation(null);
              }}
              className="mt-3 min-h-56 w-full rounded-md border border-zinc-700 bg-zinc-950/80 p-3 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-400"
              placeholder='[{"name":"session","value":"...","domain":".simcluster.ai","path":"/"}]'
            />
            {parsedCookiePayload.error ? (
              <p className="mt-2 text-xs text-amber-300">{parsedCookiePayload.error}</p>
            ) : null}

            {cookieValidation ? (
              <p className={`mt-2 text-xs ${cookieValidation.ok ? "text-lime-300" : "text-rose-300"}`}>
                {cookieValidation.message}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isCookieTesting || Boolean(parsedCookiePayload.error)}
                onClick={async () => {
                  if (parsedCookiePayload.error) return;
                  setIsCookieTesting(true);
                  try {
                    const response = await fetch("/api/cookies/test-login", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ cookies: parsedCookiePayload.cookies }),
                    });
                    const payload = (await response.json()) as { ok: boolean; message: string };
                    setCookieValidation(payload);
                  } catch {
                    setCookieValidation({ ok: false, message: "Cookie test failed to run." });
                  } finally {
                    setIsCookieTesting(false);
                  }
                }}
              >
                {isCookieTesting ? "Testing..." : "Test Login"}
              </Button>
              <Button
                disabled={Boolean(parsedCookiePayload.error)}
                onClick={() => {
                  if (parsedCookiePayload.error) return;
                  updateAccount(cookieModalAccount.id, {
                    cookies: parsedCookiePayload.cookies,
                    status: "idle",
                  });
                  toast.success(`Saved cookies for ${cookieModalAccount.xHandle}`);
                  setCookieModalAccountId(null);
                }}
              >
                Save Cookies
              </Button>
              <Button variant="ghost" onClick={() => setCookieModalAccountId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
