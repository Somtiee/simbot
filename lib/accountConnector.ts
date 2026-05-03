import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount } from "@/types";

const ACCOUNTS_FILE = serverPaths.accountsJson();
const CONNECT_STATUS_FILE = serverPaths.connectStatusJson();

type ConnectState = "idle" | "running" | "connected" | "failed";

type AccountConnectStatus = {
  state: ConnectState;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  profilePath?: string;
  profileDirectory?: string;
};

type ConnectStatusMap = Record<string, AccountConnectStatus>;

type StartConnectInput = {
  accountId: string;
  xHandle?: string;
  profilePath: string;
  profileDirectory?: string;
  browser?: "chrome" | "edge";
  interactive?: boolean;
};

const defaultStatus = (): AccountConnectStatus => ({
  state: "idle",
  message: "Not started",
});

async function readAccounts() {
  try {
    const raw = await fs.readFile(ACCOUNTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as SimclusterAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAccounts(accounts: SimclusterAccount[]) {
  await fs.mkdir(path.dirname(ACCOUNTS_FILE), { recursive: true });
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf8");
}

async function readConnectStatusMap() {
  try {
    const raw = await fs.readFile(CONNECT_STATUS_FILE, "utf8");
    return JSON.parse(raw) as ConnectStatusMap;
  } catch {
    return {};
  }
}

async function writeConnectStatusMap(map: ConnectStatusMap) {
  await fs.mkdir(path.dirname(CONNECT_STATUS_FILE), { recursive: true });
  await fs.writeFile(CONNECT_STATUS_FILE, JSON.stringify(map, null, 2), "utf8");
}

async function setAccountConnectStatus(accountId: string, patch: Partial<AccountConnectStatus>) {
  const map = await readConnectStatusMap();
  const current = map[accountId] ?? defaultStatus();
  map[accountId] = { ...current, ...patch };
  await writeConnectStatusMap(map);
}

const BROWSER_EXECUTABLES: Record<"chrome" | "edge", string[]> = {
  chrome: [
    process.env.CHROME_PATH ?? "",
    process.env.GOOGLE_CHROME_BIN ?? "",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
  edge: [
    process.env.EDGE_PATH ?? "",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ],
};

/** Interactive profile connect needs a machine with a display (not Railway / headless Linux). */
function interactiveConnectSupported() {
  if (process.env.RAILWAY_ENVIRONMENT) return false;
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return Boolean(process.env.DISPLAY);
}

/** System Chrome/Edge if installed; otherwise use Playwright’s bundled Chromium (omit path in launch). */
async function resolveBrowserExecutable(browser: "chrome" | "edge"): Promise<string | undefined> {
  const candidates = Array.from(new Set(BROWSER_EXECUTABLES[browser].filter(Boolean)));
  for (const executablePath of candidates) {
    try {
      await fs.access(executablePath);
      return executablePath;
    } catch {
      // keep searching
    }
  }
  return undefined;
}

function hasValidSimclusterSession(cookies: Cookie[], currentUrl?: string) {
  const simclusterCookies = cookies.filter((cookie) =>
    cookie.domain.toLowerCase().includes("simcluster.ai"),
  );
  if (simclusterCookies.length === 0) return false;

  const authLike = simclusterCookies.some((cookie) => {
    const name = cookie.name.toLowerCase();
    return (
      name.includes("session") ||
      name.includes("auth") ||
      name.includes("token") ||
      name.includes("sb-")
    );
  });

  const urlLooksAuthenticated =
    typeof currentUrl === "string" &&
    currentUrl.includes("simcluster.ai") &&
    !/login|sign-?in|auth/i.test(currentUrl);

  return authLike || simclusterCookies.length >= 3 || (simclusterCookies.length >= 1 && urlLooksAuthenticated);
}

async function persistCookiesToAccount(accountId: string, xHandle: string, cookies: Cookie[]) {
  const accounts = await readAccounts();
  const idx = accounts.findIndex((account) => account.id === accountId);

  const simclusterCookies = cookies.filter((cookie) =>
    cookie.domain.toLowerCase().includes("simcluster.ai"),
  );
  if (simclusterCookies.length === 0) return false;

  if (idx < 0) {
    accounts.push({
      id: accountId,
      xHandle,
      cookies: simclusterCookies,
      status: "idle",
      lastFarmed: undefined,
      cloutEstimate: undefined,
      dailyRotationSeed: undefined,
    });
  } else {
    accounts[idx] = {
      ...accounts[idx],
      xHandle: accounts[idx].xHandle || xHandle,
      cookies: simclusterCookies,
      status: "idle",
    };
  }
  await writeAccounts(accounts);
  return true;
}

export async function getAccountConnectStatus(accountId: string) {
  const map = await readConnectStatusMap();
  return map[accountId] ?? defaultStatus();
}

const bundledLaunchOpts = (executablePath?: string) => ({
  ...(executablePath ? { executablePath } : {}),
  args: [
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-blink-features=AutomationControlled",
  ],
});

export async function startAccountConnect({
  accountId,
  xHandle,
  profilePath,
  profileDirectory,
  browser = "chrome",
  interactive = true,
}: StartConnectInput) {
  const resolvedHandle = xHandle?.trim() || `@${accountId}`;
  const existing = await getAccountConnectStatus(accountId);
  if (existing.state === "running") return;

  if (interactive && !interactiveConnectSupported()) {
    await setAccountConnectStatus(accountId, {
      state: "failed",
      message:
        "This path opens Chrome on the server (no screen on Railway). Use “Link code” in Connect instead: open simcluster.ai/agent/connect, sign in, paste the code, then Connect with code.",
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  await setAccountConnectStatus(accountId, {
    state: "running",
    message: `Launching ${browser} profile...`,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    profilePath,
    profileDirectory: profileDirectory ?? "Default",
  });

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | BrowserContext | null = null;
  let launchedBrowser: Browser | null = null;
  let lastErrorMessage = "";

  const executablePath = await resolveBrowserExecutable(browser);
  const usingBundledChromium = !executablePath;

  let page: Page | null = null;
  let usingFreshLoginFallback = false;

  if (!interactive) {
    try {
      const execOpts = bundledLaunchOpts(executablePath);
      context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        ...execOpts,
        args: [
          ...execOpts.args,
          ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
        ],
        viewport: { width: 1400, height: 900 },
      });
      page = context.pages()[0] ?? (await context.newPage());
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  if (!context || !page) {
    await setAccountConnectStatus(accountId, {
      message: interactive
        ? usingBundledChromium
          ? "Opening interactive window with Playwright Chromium..."
          : `Opening interactive ${browser} login window...`
        : `Profile launch failed. Trying fresh ${browser} login window fallback... ` +
          `(${lastErrorMessage || "unknown launch error"})`,
    });

    try {
      launchedBrowser = await chromium.launch({
        headless: false,
        ...bundledLaunchOpts(executablePath),
      });
      context = await launchedBrowser.newContext({ viewport: { width: 1400, height: 900 } });
      page = await context.newPage();
      usingFreshLoginFallback = true;
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      await setAccountConnectStatus(accountId, {
        state: "failed",
        message:
          `Could not launch ${browser} profile or fallback window. ` +
          `Primary: ${lastErrorMessage || "unknown"}. Fallback: ${fallbackMessage}`,
        finishedAt: new Date().toISOString(),
      });
      return;
    }
  }

  try {
    await page.goto("https://simcluster.ai", { waitUntil: "domcontentloaded", timeout: 60000 });
    await setAccountConnectStatus(accountId, {
      message: usingFreshLoginFallback
        ? "Fresh login window opened. Sign in to simcluster.ai, then wait while session is captured."
        : "Browser opened. If needed, finish login in that profile window. Waiting for valid simcluster session...",
    });

    const started = Date.now();
    const maxWaitMs = 3 * 60 * 1000;

    while (Date.now() - started < maxWaitMs) {
      const cookies = await context.cookies("https://simcluster.ai");
      const currentUrl = page.url();
      if (hasValidSimclusterSession(cookies, currentUrl)) {
        const persisted = await persistCookiesToAccount(accountId, resolvedHandle, cookies);
        if (persisted) {
          await setAccountConnectStatus(accountId, {
            state: "connected",
            message: "Connected successfully. Session captured and saved.",
            finishedAt: new Date().toISOString(),
          });
          return;
        }
      }

      await setAccountConnectStatus(accountId, {
        message:
          "Waiting for authenticated simcluster session... keep the opened profile on simcluster.ai and finish sign-in.",
      });
      await page.waitForTimeout(2500);
    }

    await setAccountConnectStatus(accountId, {
      state: "failed",
      message: "Timed out waiting for authenticated session. Try again and complete login faster.",
      finishedAt: new Date().toISOString(),
    });
  } catch {
    await setAccountConnectStatus(accountId, {
      state: "failed",
      message: "Connection flow failed unexpectedly.",
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await context?.close().catch(() => null);
    await launchedBrowser?.close().catch(() => null);
  }
}
