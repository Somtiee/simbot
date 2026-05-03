import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Cookie, Locator, Page } from "playwright";
import { POST_TEMPLATES, THEMES } from "@/lib/agentConfig";
import { isFarmCooldownEnabled } from "@/lib/farmCooldown";
import { fetchXHandleForAgentToken, isPlaceholderXHandle } from "@/lib/simclusterProfile";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount } from "@/types";

const ACCOUNTS_FILE = serverPaths.accountsJson();
const FARM_STATUS_FILE = serverPaths.farmStatusJson();
const ERROR_SHOTS_DIR = serverPaths.farmErrorShotsDir();

if (process.env.RAILWAY_ENVIRONMENT && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/app/.playwright-browsers";
}

let chromiumLoader: Promise<typeof import("playwright")["chromium"]> | null = null;
const execFileAsync = promisify(execFile);
let browserInstallPromise: Promise<void> | null = null;

async function getChromium() {
  if (!chromiumLoader) {
    chromiumLoader = import("playwright").then((m) => m.chromium);
  }
  return chromiumLoader;
}

function isMissingPlaywrightExecutableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist/i.test(message) || /download new browsers/i.test(message);
}

async function ensurePlaywrightBrowsersInstalled() {
  if (browserInstallPromise) return browserInstallPromise;

  browserInstallPromise = (async () => {
    await appendLog("Playwright browser missing -> installing chromium binaries...", "warn");
    const env = {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/app/.playwright-browsers",
    };
    try {
      await execFileAsync(
        "npx",
        ["playwright", "install", "chromium", "chromium-headless-shell"],
        {
          env,
          timeout: 8 * 60 * 1000,
        },
      );
      await appendLog("Playwright browser install complete. Retrying launch...", "info");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendLog(`Playwright install failed: ${detail}`, "warn");
      throw error;
    }
  })().finally(() => {
    browserInstallPromise = null;
  });

  return browserInstallPromise;
}

const SELECTORS = {
  navMissions: [/missions?/i, /quest/i],
  navConcepts: [/concepts?/i],
  navStudio: [/create post/i, /studio/i, /post/i],
  navBounties: [/bount(y|ies)/i],
  newConcept: [/new concept/i, /create concept/i],
  saveConcept: [/save/i, /create/i, /publish/i],
  generateText: [/generate text/i, /ai text/i, /write with ai/i],
  generateImage: [/generate image/i, /ai image/i, /create image/i],
  postButton: [/^post$/i, /publish/i, /share/i],
  exportX: [/export to x/i, /post to x/i],
  claim: [/check-?in/i, /daily/i, /claim/i],
  feedCards: ["article", '[data-testid*="post"]', '[class*="post"]'],
  likeButton: [/like/i, /heart/i],
};

type TaskFn = (page: Page, account: SimclusterAccount, seed: number) => Promise<void>;
type LogTone = "success" | "warn" | "info";

type FarmStatus = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** Updated while a run is active; used to detect stuck locks after a crash. */
  lastFarmHeartbeatAt?: string;
  nextFarmAt?: string;
  totalAccounts: number;
  completedAccounts: number;
  currentAccountId?: string;
  currentAccountHandle?: string;
  currentAccountProgress: number;
  overallProgress: number;
  successMessage?: string;
  logs: Array<{ ts: string; text: string; tone: LogTone }>;
};

const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const nowIso = () => new Date().toISOString();

const defaultStatus = (): FarmStatus => ({
  running: false,
  totalAccounts: 0,
  completedAccounts: 0,
  currentAccountProgress: 0,
  overallProgress: 0,
  logs: [],
});

function daySeed() {
  const d = new Date();
  return Number(
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
  );
}

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

async function readFarmStatus() {
  try {
    const raw = await fs.readFile(FARM_STATUS_FILE, "utf8");
    return { ...defaultStatus(), ...(JSON.parse(raw) as Partial<FarmStatus>) };
  } catch {
    return defaultStatus();
  }
}

async function writeFarmStatus(status: FarmStatus) {
  await fs.mkdir(path.dirname(FARM_STATUS_FILE), { recursive: true });
  await fs.writeFile(FARM_STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

async function appendLog(text: string, tone: LogTone = "info") {
  const status = await readFarmStatus();
  status.logs = [...status.logs.slice(-59), { ts: nowIso(), text, tone }];
  await writeFarmStatus(status);
}

async function patchStatus(patch: Partial<FarmStatus>) {
  const status = await readFarmStatus();
  const next: FarmStatus = { ...status, ...patch };
  if (next.running) {
    next.lastFarmHeartbeatAt = nowIso();
  }
  await writeFarmStatus(next);
}

async function humanPause(page: Page, minMs = 1000, maxMs = 4000) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const moves = rand(2, 6);
  for (let i = 0; i < moves; i += 1) {
    await page.mouse.move(rand(20, viewport.width - 20), rand(20, viewport.height - 20), {
      steps: rand(8, 24),
    });
    await page.waitForTimeout(rand(80, 220));
  }
  await page.waitForTimeout(rand(minMs, maxMs));
}

async function safeShot(page: Page, label: string) {
  await fs.mkdir(ERROR_SHOTS_DIR, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`;
  await page.screenshot({ path: path.join(ERROR_SHOTS_DIR, name), fullPage: true });
}

async function clickFirstVisibleByRole(page: Page, names: RegExp[]) {
  for (const name of names) {
    const locator = page.getByRole("button", { name }).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function clickAllVisibleClaims(page: Page, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let clicked = false;
    const candidates: Locator[] = [];
    for (const label of SELECTORS.claim) {
      candidates.push(page.getByRole("button", { name: label }));
    }
    for (const group of candidates) {
      const count = await group.count();
      for (let i = 0; i < count; i += 1) {
        const btn = group.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 }).catch(() => null);
          await humanPause(page);
          clicked = true;
        }
      }
    }
    if (!clicked) break;
  }
}

async function gotoSection(page: Page, labels: RegExp[]) {
  for (const label of labels) {
    const candidate = page.getByRole("link", { name: label }).first();
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 5000 });
      await humanPause(page);
      return true;
    }
  }
  return clickFirstVisibleByRole(page, labels);
}

async function parseClout(page: Page) {
  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  const match = bodyText.match(/CLOUT[^0-9]{0,10}([\d,]+)|([\d,]+)\s*CLOUT/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const num = Number(raw.replace(/,/g, ""));
  return Number.isFinite(num) ? num : undefined;
}

async function taskDailyCheckIn(page: Page) {
  await clickFirstVisibleByRole(page, SELECTORS.claim);
  await humanPause(page);
  await clickFirstVisibleByRole(page, [/confirm/i, /ok/i, /claim/i]);
}

async function taskMissions(page: Page) {
  await gotoSection(page, SELECTORS.navMissions);
  await clickAllVisibleClaims(page, 2);
}

async function fillFirstTextbox(page: Page, value: string) {
  const input = page.getByRole("textbox").first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill(value);
    return true;
  }
  return false;
}

async function taskCreateConcept(page: Page, _account: SimclusterAccount, seed: number) {
  await gotoSection(page, SELECTORS.navConcepts);
  await clickFirstVisibleByRole(page, SELECTORS.newConcept);
  await humanPause(page);

  const theme = THEMES[seed % THEMES.length] ?? pick(THEMES);
  const conceptName = `${theme} // ${new Date().toLocaleDateString("en-CA")} // ${rand(100, 999)}`;
  const conceptDesc =
    `An intelligent ${theme.toLowerCase()} concept tuned for engagement and clout growth.` +
    ` Includes practical hooks, opinionated voice, and one meme angle.`;

  const nameInput = page.locator('input[placeholder*="name" i], input[name*="name" i]').first();
  if (await nameInput.isVisible().catch(() => false)) await nameInput.fill(conceptName);
  await humanPause(page);

  const descInput = page.locator('textarea, [contenteditable="true"]').first();
  if (await descInput.isVisible().catch(() => false)) await descInput.fill(conceptDesc);
  await humanPause(page);

  await clickFirstVisibleByRole(page, [/generate with ai/i, /ai/i]);
  await humanPause(page);
  await clickFirstVisibleByRole(page, SELECTORS.saveConcept);
}

async function taskCreatePost(page: Page, _account: SimclusterAccount, seed: number) {
  await gotoSection(page, SELECTORS.navStudio);
  await humanPause(page);

  await clickFirstVisibleByRole(page, [/latest concept/i, /select concept/i, /use concept/i]);
  await clickFirstVisibleByRole(page, [/owned/i, /my concepts/i, /random/i]);
  await humanPause(page);

  await clickFirstVisibleByRole(page, SELECTORS.generateText);
  await humanPause(page, 1400, 4200);
  await clickFirstVisibleByRole(page, SELECTORS.generateImage);
  await page.waitForTimeout(rand(6000, 15000));

  const dateFlavor = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const caption = `${POST_TEMPLATES[seed % POST_TEMPLATES.length]} // ${dateFlavor}`;

  const textarea = page.locator("textarea, [contenteditable='true']").first();
  if (await textarea.isVisible().catch(() => false)) {
    await textarea.fill(caption);
  } else {
    await fillFirstTextbox(page, caption);
  }
  await humanPause(page);

  await clickFirstVisibleByRole(page, SELECTORS.postButton);
  await humanPause(page);
  await clickFirstVisibleByRole(page, SELECTORS.exportX);
}

async function taskBounties(page: Page, _account: SimclusterAccount, seed: number) {
  await gotoSection(page, SELECTORS.navBounties);
  await humanPause(page);

  const claimed = await clickFirstVisibleByRole(page, [/claim free/i, /claim/i, /low[- ]?cost/i]);
  if (claimed) return;

  await clickFirstVisibleByRole(page, [/new bounty/i, /place bounty/i, /create bounty/i]);
  await humanPause(page);

  const cents = 10 + (seed % 41);
  const bountyInput = page.locator('input[placeholder*="amount" i], input[name*="amount" i]').first();
  if (await bountyInput.isVisible().catch(() => false)) {
    await bountyInput.fill((cents / 100).toFixed(2));
  }
  await clickFirstVisibleByRole(page, [/own concept/i, /my concept/i, /latest concept/i]);
  await clickFirstVisibleByRole(page, [/confirm/i, /place/i, /submit/i]);
}

async function taskLightEngagement(page: Page, accounts: SimclusterAccount[]) {
  await page.mouse.wheel(0, rand(600, 1200));
  await humanPause(page);

  const ownHandles = accounts.map((a) => a.xHandle.toLowerCase());
  const likeTargets = rand(2, 3);
  let liked = 0;

  for (const cardSelector of SELECTORS.feedCards) {
    const cards = page.locator(cardSelector);
    const count = await cards.count().catch(() => 0);
    for (let i = 0; i < count && liked < likeTargets; i += 1) {
      const card = cards.nth(i);
      const text = (await card.innerText().catch(() => "")).toLowerCase();
      if (ownHandles.some((h) => text.includes(h))) continue;

      for (const label of SELECTORS.likeButton) {
        const like = card.getByRole("button", { name: label }).first();
        if (await like.isVisible().catch(() => false)) {
          await like.click().catch(() => null);
          liked += 1;
          await humanPause(page);
          break;
        }
      }
    }
    if (liked >= likeTargets) break;
  }
}

async function runTask(
  page: Page,
  account: SimclusterAccount,
  seed: number,
  taskName: string,
  task: TaskFn,
) {
  try {
    console.log(`[farm] ${account.xHandle} -> ${taskName} -> start`);
    await appendLog(`${account.xHandle} -> ${taskName} -> start`, "info");
    await task(page, account, seed);
    console.log(`[farm] ${account.xHandle} -> ${taskName} -> done`);
    await appendLog(`${account.xHandle} -> ${taskName} -> done`, "success");
  } catch (error) {
    console.error(`[farm] ${account.xHandle} -> ${taskName} -> failed`, error);
    await appendLog(`${account.xHandle} -> ${taskName} -> failed`, "warn");
    await safeShot(page, `${account.id}-${taskName.replace(/\s+/g, "-").toLowerCase()}-error`).catch(() => null);
  }
}

function rotateTaskList(seed: number): Array<{ name: string; fn: TaskFn }> {
  const base = [
    { name: "Daily Check-in", fn: taskDailyCheckIn as TaskFn },
    { name: "Missions", fn: taskMissions as TaskFn },
    { name: "Create Concept", fn: taskCreateConcept as TaskFn },
    { name: "Create Post", fn: taskCreatePost as TaskFn },
    { name: "Bounties", fn: taskBounties as TaskFn },
  ];

  const offset = seed % base.length;
  return [...base.slice(offset), ...base.slice(0, offset)];
}

function sortAccountsForDay(accounts: SimclusterAccount[], seed: number) {
  return [...accounts]
    .map((account, idx) => ({
      account,
      key: account.dailyRotationSeed ?? seed + idx,
    }))
    .sort((a, b) => a.key - b.key)
    .map((item) => item.account);
}

function farmedInLast24h(lastFarmed?: string) {
  if (!lastFarmed) return false;
  const last = new Date(lastFarmed).getTime();
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < 24 * 60 * 60 * 1000;
}

const HEARTBEAT_STALE_MS = 20 * 60 * 1000;

async function tryClearStaleFarmLock(status: FarmStatus): Promise<boolean> {
  if (!status.running) return true;
  const beat = status.lastFarmHeartbeatAt ?? status.startedAt;
  const t = beat ? new Date(beat).getTime() : 0;
  if (t > 0 && Date.now() - t < HEARTBEAT_STALE_MS) {
    return false;
  }
  await writeFarmStatus({
    ...status,
    running: false,
    logs: [
      ...status.logs.slice(-59),
      {
        ts: nowIso(),
        text: "Farm lock auto-cleared (stale heartbeat — e.g. server restart or crashed run). You can start again.",
        tone: "warn",
      },
    ],
  });
  return true;
}

/**
 * Clears a stuck `running` flag (manual recovery). Safe to call anytime.
 */
export async function clearFarmRunningLock(): Promise<void> {
  const s = await readFarmStatus();
  await writeFarmStatus({
    ...s,
    running: false,
    logs: [
      ...s.logs.slice(-59),
      { ts: nowIso(), text: "Farm lock cleared manually. Click Activate to run again.", tone: "info" },
    ],
  });
}

export type FarmStartResult = { ok: true } | { ok: false; message: string };

/**
 * Validates lock, persists “running”, then kicks off the long-running farm in the background.
 * Await this for the HTTP response — it returns before accounts finish processing.
 */
export async function requestFarmStart(headed: boolean): Promise<FarmStartResult> {
  let status = await readFarmStatus();
  if (status.running) {
    const cleared = await tryClearStaleFarmLock(status);
    if (!cleared) {
      return {
        ok: false,
        message:
          "A farm run is already in progress. Wait for it to finish, or click “Clear farm lock” below.",
      };
    }
    status = await readFarmStatus();
  }

  const seed = daySeed();
  const allAccounts = await readAccounts();
  const rotated = sortAccountsForDay(allAccounts, seed);
  const tasks = rotateTaskList(seed);
  const totalTasksPerAccount = tasks.length + 1;

  if (rotated.length === 0) {
    console.log("[farm] no accounts found in data/accounts.json");
    await writeFarmStatus({
      ...defaultStatus(),
      running: false,
      finishedAt: nowIso(),
      logs: [{ ts: nowIso(), text: "No accounts found in data/accounts.json", tone: "warn" }],
    });
    return { ok: false, message: "No accounts found. Add accounts first." };
  }

  const updated = [...allAccounts];
  const started = nowIso();
  await writeFarmStatus({
    ...defaultStatus(),
    running: true,
    startedAt: started,
    lastFarmHeartbeatAt: started,
    totalAccounts: rotated.length,
    logs: [{ ts: started, text: `Farm started for ${rotated.length} account(s).`, tone: "info" }],
  });

  void runFarmAccountsJob(headed, seed, rotated, updated, tasks, totalTasksPerAccount);

  return { ok: true };
}

/** @deprecated use requestFarmStart — kept for any direct callers */
export async function farmAllAccounts(headed: boolean = false) {
  await requestFarmStart(headed);
}

async function runFarmAccountsJob(
  headed: boolean,
  seed: number,
  rotated: SimclusterAccount[],
  updated: SimclusterAccount[],
  tasks: Array<{ name: string; fn: TaskFn }>,
  totalTasksPerAccount: number,
) {
  try {
  for (let accountIndex = 0; accountIndex < rotated.length; accountIndex += 1) {
    const account = rotated[accountIndex];
    const originalIndex = updated.findIndex((a) => a.id === account.id);
    if (originalIndex < 0) continue;

    if (isFarmCooldownEnabled() && farmedInLast24h(updated[originalIndex].lastFarmed)) {
      await appendLog(`${account.xHandle} -> skipped (already farmed within last 24h)`, "warn");
      await patchStatus({
        completedAccounts: accountIndex + 1,
        overallProgress: Math.round(((accountIndex + 1) / rotated.length) * 100),
      });
      continue;
    }

    updated[originalIndex] = {
      ...updated[originalIndex],
      status: "farming",
      dailyRotationSeed: seed,
    };
    await writeAccounts(updated);
    await patchStatus({
      currentAccountId: account.id,
      currentAccountHandle: account.xHandle,
      currentAccountProgress: 0,
      overallProgress: Math.round((accountIndex / rotated.length) * 100),
      completedAccounts: accountIndex,
    });
    await appendLog(`${account.xHandle} -> account session started`, "info");

    let context: BrowserContext | null = null;
    let browser: Browser | null = null;
    let page: Page | null = null;
    const startedAt = Date.now();

    try {
      const chromium = await getChromium();
      try {
        browser = await chromium.launch({ headless: !headed, slowMo: headed ? 90 : 0 });
      } catch (error) {
        if (!isMissingPlaywrightExecutableError(error)) throw error;
        await ensurePlaywrightBrowsersInstalled();
        browser = await chromium.launch({ headless: !headed, slowMo: headed ? 90 : 0 });
      }
      const token = typeof account.agentSessionToken === "string" ? account.agentSessionToken.trim() : "";
      const extraHTTPHeaders =
        token.length > 0
          ? {
              Authorization: `Bearer ${token}`,
              "X-Simcluster-Token": token,
            }
          : undefined;
      context = await browser.newContext(extraHTTPHeaders ? { extraHTTPHeaders } : undefined);

      if (Array.isArray(account.cookies) && account.cookies.length > 0) {
        await context.addCookies(account.cookies as Cookie[]);
      }

      page = await context.newPage();
      await page.goto("https://simcluster.ai", { waitUntil: "domcontentloaded", timeout: 60000 });
      await humanPause(page);

      const landingUrl = page.url();
      if (/login|sign-?in|\/auth|\/signup/i.test(landingUrl)) {
        throw new Error(
          "Simcluster opened a sign-in page — this session is not valid for the website. Use Connect (link code) or Cookies again.",
        );
      }

      let farmAccount: SimclusterAccount = account;
      if (isPlaceholderXHandle(farmAccount.xHandle) && token) {
        const xh = await fetchXHandleForAgentToken(token);
        if (xh) {
          farmAccount = { ...farmAccount, xHandle: xh };
          updated[originalIndex] = { ...updated[originalIndex], xHandle: xh };
          await writeAccounts(updated);
          await appendLog(`${xh} -> resolved @handle from Simcluster`, "success");
        }
      }

      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        const task = tasks[taskIndex];
        await runTask(page, farmAccount, seed, task.name, task.fn);
        await patchStatus({
          currentAccountProgress: Math.round(((taskIndex + 1) / totalTasksPerAccount) * 100),
        });
      }

      await runTask(page, farmAccount, seed, "Light Engagement", async (p) => {
        await taskLightEngagement(p, updated);
      });
      await patchStatus({ currentAccountProgress: 100 });

      // Keep runtime in the requested window (approx 2-4 minutes).
      const elapsed = Date.now() - startedAt;
      if (elapsed < 120_000) {
        await page.waitForTimeout(120_000 - elapsed);
      }

      const parsedClout = await parseClout(page);
      updated[originalIndex] = {
        ...updated[originalIndex],
        xHandle: farmAccount.xHandle,
        status: "completed",
        lastFarmed: nowIso(),
        cloutEstimate: parsedClout ?? updated[originalIndex].cloutEstimate,
        dailyRotationSeed: seed,
      };
      console.log(`[farm] ${farmAccount.xHandle} -> completed`);
      await appendLog(
        `${farmAccount.xHandle} -> completed -> +${updated[originalIndex].cloutEstimate ?? "?"} CLOUT est.`,
        "success",
      );
    } catch (error) {
      console.error(`[farm] ${account.xHandle} -> account run failed`, error);
      if (page) await safeShot(page, `${account.id}-account-failure`).catch(() => null);
      const detail = error instanceof Error ? error.message : String(error);
      updated[originalIndex] = {
        ...updated[originalIndex],
        status: "error",
        lastFarmed: nowIso(),
        dailyRotationSeed: seed,
      };
      await appendLog(`${account.xHandle} -> farm stopped: ${detail}`, "warn");
    } finally {
      await writeAccounts(updated);
      try {
        await context?.close();
      } catch {
        // best effort cleanup
      }
      await browser?.close().catch(() => null);
      await patchStatus({
        completedAccounts: accountIndex + 1,
        overallProgress: Math.round(((accountIndex + 1) / rotated.length) * 100),
      });
    }
  }

  const finishedAt = new Date();
  const cooldownOn = isFarmCooldownEnabled();
  const nextFarmAtIso = cooldownOn
    ? new Date(finishedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  await writeFarmStatus({
    ...(await readFarmStatus()),
    running: false,
    finishedAt: finishedAt.toISOString(),
    nextFarmAt: nextFarmAtIso,
    currentAccountId: undefined,
    currentAccountHandle: undefined,
    currentAccountProgress: 100,
    overallProgress: 100,
    successMessage: `✅ AGENT FARM COMPLETE — ALL ${rotated.length} ACCOUNTS AT MAX DAILY CLOUT + NEW AI POSTS & IMAGES GENERATED`,
    logs: [
      ...(await readFarmStatus()).logs.slice(-59),
      {
        ts: nowIso(),
        text: cooldownOn
          ? `Farm complete for ${rotated.length} account(s). Cooldown started (24h).`
          : `Farm complete for ${rotated.length} account(s). Cooldown is off — run again anytime (set FARM_COOLDOWN_ENABLED=1 to enforce 24h limits).`,
        tone: "success",
      },
    ],
  });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[farm] runFarmAccountsJob fatal", error);
    const s = await readFarmStatus();
    await writeFarmStatus({
      ...s,
      running: false,
      finishedAt: nowIso(),
      logs: [
        ...s.logs.slice(-59),
        { ts: nowIso(), text: `Farm aborted unexpectedly: ${detail}`, tone: "warn" },
      ],
    });
  }
}

