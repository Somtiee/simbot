import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Cookie, Locator, Page } from "playwright";
import { POST_TEMPLATES, THEMES } from "@/lib/agentConfig";
import { isFarmCooldownEnabled } from "@/lib/farmCooldown";
import { fetchXHandleForAgentToken, isPlaceholderXHandle } from "@/lib/simclusterProfile";
import { readSquadConfig, normalizeSquadConfig } from "@/lib/squadConfig";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount, SquadFlywheelConfig } from "@/types";

const ACCOUNTS_FILE = serverPaths.accountsJson();
const FARM_STATUS_FILE = serverPaths.farmStatusJson();
const ERROR_SHOTS_DIR = serverPaths.farmErrorShotsDir();

if (process.env.RAILWAY_ENVIRONMENT && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/app/.playwright-browsers";
}

let chromiumLoader: Promise<typeof import("playwright")["chromium"]> | null = null;
const execFileAsync = promisify(execFile);
let browserInstallPromise: Promise<void> | null = null;
let browserDepsInstallPromise: Promise<void> | null = null;

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

function isMissingSharedLibraryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /error while loading shared libraries/i.test(message) || /libglib-2\.0\.so\.0/i.test(message);
}

async function ensurePlaywrightSystemDepsInstalled() {
  if (browserDepsInstallPromise) return browserDepsInstallPromise;

  browserDepsInstallPromise = (async () => {
    await appendLog("Playwright system libs missing -> installing runtime deps...", "warn");
    try {
      await execFileAsync("npx", ["playwright", "install-deps", "chromium"], {
        env: process.env,
        timeout: 10 * 60 * 1000,
      });
      await appendLog("Playwright system deps install complete. Retrying launch...", "info");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendLog(`Playwright system deps install failed: ${detail}`, "warn");
      throw error;
    }
  })().finally(() => {
    browserDepsInstallPromise = null;
  });

  return browserDepsInstallPromise;
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
          timeout: 2 * 60 * 1000,
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

async function launchWithPathFallback(chromium: typeof import("playwright")["chromium"], headed: boolean) {
  try {
    return await chromium.launch({ headless: !headed, slowMo: headed ? 90 : 0 });
  } catch (error) {
    if (!isMissingPlaywrightExecutableError(error) || !process.env.PLAYWRIGHT_BROWSERS_PATH) {
      throw error;
    }
    const pinnedPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    await appendLog(`Pinned browser path (${pinnedPath}) failed. Retrying with default Playwright cache...`, "warn");
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    try {
      return await chromium.launch({ headless: !headed, slowMo: headed ? 90 : 0 });
    } catch (fallbackError) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = pinnedPath;
      throw fallbackError;
    }
  }
}

async function launchChromiumWithSelfHeal(headed: boolean): Promise<Browser> {
  const chromium = await getChromium();
  try {
    return await launchWithPathFallback(chromium, headed);
  } catch (firstError) {
    if (isMissingPlaywrightExecutableError(firstError)) {
      await ensurePlaywrightBrowsersInstalled();
    }
    if (isMissingSharedLibraryError(firstError)) {
      await ensurePlaywrightSystemDepsInstalled();
    }
    if (!isMissingPlaywrightExecutableError(firstError)) {
      // First launch error often wraps root cause as "Target page/context/browser has been closed".
      // Installing browsers again is cheap compared to hard-failing the whole farm run.
      await ensurePlaywrightBrowsersInstalled();
    }
    try {
      return await launchWithPathFallback(chromium, headed);
    } catch (secondError) {
      if (isMissingPlaywrightExecutableError(secondError)) {
        await ensurePlaywrightBrowsersInstalled();
      }
      if (isMissingSharedLibraryError(secondError)) {
        await ensurePlaywrightSystemDepsInstalled();
      }
      return launchWithPathFallback(chromium, headed);
    }
  }
}

const SELECTORS = {
  navMissions: [/missions?/i, /quest/i],
  navConcepts: [/concepts?/i],
  navStudio: [/create post/i, /studio/i, /post/i, /new content/i],
  navBounties: [/bount(y|ies)/i],
  newContent: [/new content/i, /create post/i, /compose/i],
  newConcept: [/new concept/i, /create concept/i],
  saveConcept: [/save/i, /create/i, /publish/i],
  generateText: [/generate text/i, /ai text/i, /write with ai/i],
  generateImage: [/generate image/i, /ai image/i, /create image/i],
  postButton: [/^post$/i, /publish/i, /share/i],
  exportX: [/export to x/i, /post to x/i],
  claim: [/check-?in/i, /daily/i, /claim/i],
  feedCards: ["article", '[data-testid*="post"]', '[class*="post"]'],
  likeButton: [/like/i, /heart/i],
  // Squad flywheel bounty controls (text-first to survive layout changes).
  bountyCreateButton: [/create.*bounty/i, /new bounty/i, /set bounty/i, /place bounty/i],
  bountyTitleInput:
    'input[placeholder*="title" i], input[name*="title" i], input[aria-label*="title" i]',
  bountyDescriptionInput:
    'textarea[placeholder*="description" i], textarea[name*="description" i], textarea, [contenteditable="true"]',
  bountySearchInput:
    'input[placeholder*="search" i], input[name*="search" i], input[aria-label*="search" i], input[type="search"]',
  bountySubmitButton: [/submit/i, /create/i, /confirm/i, /publish/i, /place/i],
  bountyClaimButton: [/claim/i, /complete/i, /collect/i, /reward/i, /farm/i],
  bountyUseConceptButton: [/use concept/i, /select concept/i, /open concept/i, /generate/i],
  bountyOpenCardButton: [/view/i, /open/i, /details?/i, /farm/i],
};

const SECTION_ROUTES = {
  bonuses: ["https://simcluster.ai/bonuses", "https://simcluster.ai"],
  bounties: ["https://simcluster.ai/bounties", "https://simcluster.ai"],
  missions: ["https://simcluster.ai/get-delta", "https://simcluster.ai/missions", "https://simcluster.ai"],
  concepts: ["https://simcluster.ai", "https://simcluster.ai/concepts"],
} as const;

type TaskFn = (page: Page, account: SimclusterAccount, seed: number) => Promise<void>;
type LogTone = "success" | "warn" | "info";
type TaskDef = { name: string; fn: TaskFn; required: boolean };

type FarmStatus = {
  running: boolean;
  runId?: string;
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
  squadConfig?: SquadFlywheelConfig;
  bountyCycleDate?: string;
  bountyCreatedCount?: number;
  bountyFarmedCount?: number;
  estimatedCloutEarned?: number;
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
  bountyCreatedCount: 0,
  bountyFarmedCount: 0,
  estimatedCloutEarned: 0,
  logs: [],
});

function getPostsPerAccountTarget() {
  const raw = Number(process.env.FARM_POSTS_PER_ACCOUNT ?? 4);
  if (!Number.isFinite(raw)) return 4;
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

const SQUAD_BOUNTY_PREFIX = "🔥 SQUAD-BOUNTY";
const SQUAD_BOUNTY_DESC_TEMPLATES = [
  "Drop your hardest {theme} slop using this concept and earn massive clout 🔥",
  "Speed-run a wild {theme} post from this concept and collect reward energy.",
  "Make one chaotic but useful {theme} post. Bonus points for meme precision.",
  "Cook a high-reply {theme} post from this concept and farm the leaderboard.",
  "Ship an AI-savage {theme} angle and cash this bounty instantly.",
  "Post your most degen {theme} insight using this concept and claim clout.",
  "Turn this concept into a scroll-stopping {theme} post and harvest rewards.",
  "Build a spicy {theme} narrative from this concept and print engagement.",
  "Create a clean, viral-ready {theme} slop post and lock in the bounty.",
  "One concept, one cracked {theme} post, one fast reward. Execute now.",
  "Generate a bold {theme} post, then submit and claim this squad bounty.",
];

function todayKeyUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function safeHandleTag(handle: string): string {
  return handle.replace(/^@+/, "").replace(/[^a-z0-9_]/gi, "").slice(0, 24) || "acct";
}

function isSameBountyCycle(a?: string, b?: string): boolean {
  return Boolean(a && b && a === b);
}

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
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5000 }).catch(() => null);
      return true;
    }

    const link = page.getByRole("link", { name }).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click({ timeout: 5000 }).catch(() => null);
      return true;
    }

    const generic = page.locator("button, a, [role='button'], [role='link']").filter({ hasText: name }).first();
    if (await generic.isVisible().catch(() => false)) {
      await generic.click({ timeout: 5000 }).catch(() => null);
      return true;
    }

    const textTarget = page.getByText(name).first();
    if (await textTarget.isVisible().catch(() => false)) {
      await textTarget.click({ timeout: 5000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

async function isPostComposerVisible(page: Page) {
  const textarea = page.locator("textarea, [contenteditable='true']").first();
  if (await textarea.isVisible().catch(() => false)) return true;

  for (const re of SELECTORS.generateText) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.isVisible().catch(() => false)) return true;
  }
  for (const re of SELECTORS.generateImage) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.isVisible().catch(() => false)) return true;
  }
  return false;
}

async function openPostComposer(page: Page) {
  const isLoggedOut = async () => {
    const u = page.url();
    if (/login|sign-?in|\/auth|\/signup/i.test(u)) return true;
    const signIn = page.getByRole("button", { name: /sign in|log in|continue with/i }).first();
    return signIn.isVisible().catch(() => false);
  };

  const clickTargets = async () => {
    if (await clickFirstVisibleByRole(page, [/new content/i, /create post/i, /compose/i])) return true;

    const explicit = page
      .locator(
        "button, a, [role='button'], [role='link']",
      )
      .filter({ hasText: /new content|create post|compose/i })
      .first();
    if (await explicit.isVisible().catch(() => false)) {
      await explicit.click({ timeout: 5000 }).catch(() => null);
      return true;
    }

    const ariaTarget = page
      .locator("[aria-label*='new content' i], [title*='new content' i], [data-testid*='new-content' i]")
      .first();
    if (await ariaTarget.isVisible().catch(() => false)) {
      await ariaTarget.click({ timeout: 5000 }).catch(() => null);
      return true;
    }
    return false;
  };

  if (await isPostComposerVisible(page)) return true;
  if (await isLoggedOut()) {
    throw new Error("Session appears logged out while opening post composer.");
  }

  const clicked = await clickTargets();
  if (clicked) {
    await humanPause(page);
    if (await isPostComposerVisible(page)) return true;
  }

  const routeGuesses = [
    "https://simcluster.ai/home",
    "https://simcluster.ai/studio",
    "https://simcluster.ai/create",
    "https://simcluster.ai/post",
    "https://simcluster.ai",
  ];
  for (const url of routeGuesses) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
    await humanPause(page, 900, 2200);
    if (await isLoggedOut()) {
      throw new Error("Session appears logged out while opening post composer.");
    }
    if (await isPostComposerVisible(page)) return true;
    const clickedAfterGoto = await clickTargets();
    if (clickedAfterGoto) {
      await humanPause(page);
      if (await isPostComposerVisible(page)) return true;
    }
  }
  return false;
}

async function clickAllVisibleClaims(page: Page, retries = 2, labels: RegExp[] = SELECTORS.claim) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let clicked = false;
    const candidates: Locator[] = [];
    for (const label of labels) {
      candidates.push(page.getByRole("button", { name: label }));
      candidates.push(
        page
          .locator("button, a, [role='button'], [role='link'], div")
          .filter({ hasText: label }),
      );
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

async function openSectionWithRoutes(page: Page, labels: RegExp[], routes: readonly string[]) {
  await dismissBlockingOverlays(page);
  if (await gotoSection(page, labels)) return true;
  for (const route of routes) {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
    await humanPause(page, 700, 1500);
    await dismissBlockingOverlays(page);
    if (await gotoSection(page, labels)) return true;
    const landed = page.url();
    if (landed.toLowerCase().startsWith(route.toLowerCase())) return true;
  }
  return false;
}

async function dismissBlockingOverlays(page: Page) {
  await page.keyboard.press("Escape").catch(() => null);
  const closeTargets = page
    .locator("button, [role='button'], [aria-label], [title]")
    .filter({ hasText: /close|dismiss|got it|ok/i });
  const n = await closeTargets.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 2); i += 1) {
    const btn = closeTargets.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000, force: true }).catch(() => null);
      await page.waitForTimeout(200).catch(() => null);
    }
  }
  const topRightClose = page.locator("button[aria-label*='close' i], button[title*='close' i]").first();
  if (await topRightClose.isVisible().catch(() => false)) {
    await topRightClose.click({ timeout: 2000, force: true }).catch(() => null);
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
  const openedBonuses = await openSectionWithRoutes(page, [/bonuses?/i, /daily bonus/i, /daily sign/i], SECTION_ROUTES.bonuses);
  if (!openedBonuses) throw new Error("Could not open Bonuses/Daily panel.");
  await humanPause(page, 900, 2000);
  await clickFirstVisibleByRole(page, [/daily sign-?in bonus/i, /daily bonus/i, /streak/i]).catch(() => null);
  await page.mouse.wheel(0, 900).catch(() => null);
  await humanPause(page, 500, 1100);
  const claimButtons = page
    .locator("button, a, [role='button'], [role='link']")
    .filter({ hasText: /(^claim\b|claim\s*\+?\d+\s*[c¢]?)/i });
  const claimCount = await claimButtons.count().catch(() => 0);
  let clicked = false;
  for (let i = 0; i < Math.min(4, claimCount); i += 1) {
    const target = claimButtons.nth(i);
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 3000, force: true }).catch(() => null);
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    if (/expires in 24 hours|already claimed|next reward|streak/i.test(bodyText)) {
      await appendLog("Daily check-in appears already claimed for this session.", "info");
    } else {
      throw new Error("Daily check-in controls were not found.");
    }
  }
  await humanPause(page);
  await clickFirstVisibleByRole(page, [/confirm/i, /ok/i, /claim/i, /continue/i]);
  await dismissBlockingOverlays(page);
}

async function taskMissions(page: Page) {
  const opened = await openSectionWithRoutes(page, [...SELECTORS.navMissions, /get delta/i], SECTION_ROUTES.missions);
  if (!opened) {
    throw new Error("Could not open Missions.");
  }
  const before = (await page.locator("body").innerText().catch(() => "")) || "";
  await clickAllVisibleClaims(page, 2, [/claim/i, /collect/i, /complete/i, /reward/i]);
  const after = (await page.locator("body").innerText().catch(() => "")) || "";
  if (before === after) {
    await appendLog("Missions page opened but no claimable items were detected.", "warn");
  }
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
  const opened =
    (await openSectionWithRoutes(page, [...SELECTORS.navConcepts, /new concept/i], SECTION_ROUTES.concepts)) ||
    (await clickFirstVisibleByRole(page, SELECTORS.newConcept));
  if (!opened) {
    throw new Error("Could not open Concepts.");
  }
  let startedConcept = await clickFirstVisibleByRole(page, SELECTORS.newConcept);
  if (!startedConcept) {
    const conceptEditorPresent =
      (await page.locator('input[placeholder*="name" i], input[name*="name" i]').first().isVisible().catch(() => false)) ||
      (await page.locator('textarea, [contenteditable="true"]').first().isVisible().catch(() => false));
    if (conceptEditorPresent) {
      startedConcept = true;
    }
  }
  if (!startedConcept) {
    const sidebarNewConcept = page
      .locator("button, a, [role='button'], [role='link']")
      .filter({ hasText: /new concept/i })
      .first();
    if (await sidebarNewConcept.isVisible().catch(() => false)) {
      await sidebarNewConcept.click({ timeout: 5000, force: true }).catch(() => null);
      startedConcept = true;
    }
  }
  if (!startedConcept) {
    throw new Error("Could not start a new concept.");
  }
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

  await clickFirstVisibleByRole(page, [/generate with ai/i, /ai/i, /generate/i]);
  await humanPause(page);
  const saved = await clickFirstVisibleByRole(page, SELECTORS.saveConcept);
  if (!saved) {
    throw new Error("Could not save/create concept.");
  }
}

async function taskCreatePost(page: Page, _account: SimclusterAccount, seed: number) {
  let composerReady = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    composerReady = await openPostComposer(page);
    if (composerReady) break;
    await appendLog(`Create Post -> retrying composer open (${attempt}/2)`, "warn");
  }
  if (!composerReady) {
    throw new Error("Could not open post composer.");
  }
  await humanPause(page);

  await clickFirstVisibleByRole(page, [/latest concept/i, /select concept/i, /use concept/i]);
  await clickFirstVisibleByRole(page, [/owned/i, /my concepts/i, /random/i]);
  await humanPause(page);

  const generatedText = await clickFirstVisibleByRole(page, SELECTORS.generateText);
  await humanPause(page, 1400, 4200);
  const generatedImage = await clickFirstVisibleByRole(page, SELECTORS.generateImage);
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
    const filled = await fillFirstTextbox(page, caption);
    if (!filled && !generatedText && !generatedImage) {
      throw new Error("Post composer inputs were not found.");
    }
  }
  await humanPause(page);

  const posted = await clickFirstVisibleByRole(page, SELECTORS.postButton);
  if (!posted) {
    throw new Error("Could not find Post/Publish button.");
  }
  await humanPause(page);
  await clickFirstVisibleByRole(page, SELECTORS.exportX);
}

async function taskBounties(page: Page, _account: SimclusterAccount, seed: number) {
  const opened = await openSectionWithRoutes(page, SELECTORS.navBounties, SECTION_ROUTES.bounties);
  if (!opened) {
    throw new Error("Could not open Bounties.");
  }
  await humanPause(page);

  const claimed = await clickFirstVisibleByRole(page, [/claim free/i, /claim/i, /low[- ]?cost/i]);
  if (claimed) return;

  const started = await clickFirstVisibleByRole(page, [/new bounty/i, /place bounty/i, /create bounty/i]);
  if (!started) {
    await appendLog("Bounties page open but no claimable/new bounty action visible.", "warn");
    return;
  }
  await humanPause(page);

  const cents = 10 + (seed % 41);
  const bountyInput = page.locator('input[placeholder*="amount" i], input[name*="amount" i]').first();
  if (await bountyInput.isVisible().catch(() => false)) {
    await bountyInput.fill((cents / 100).toFixed(2));
  }
  await clickFirstVisibleByRole(page, [/own concept/i, /my concept/i, /latest concept/i]);
  const submitted = await clickFirstVisibleByRole(page, [/confirm/i, /place/i, /submit/i, /create/i]);
  if (!submitted) {
    throw new Error("Could not submit bounty.");
  }
}

async function fillFirstVisibleLocator(page: Page, selector: string, value: string): Promise<boolean> {
  const field = page.locator(selector).first();
  if (await field.isVisible().catch(() => false)) {
    await field.fill(value).catch(() => null);
    return true;
  }
  return false;
}

async function ensureBountiesSection(page: Page): Promise<boolean> {
  const opened = await openSectionWithRoutes(page, SELECTORS.navBounties, SECTION_ROUTES.bounties);
  if (!opened) return false;
  await humanPause(page, 800, 1800);
  return true;
}

function resolveBountyDescription(
  account: SimclusterAccount,
  index: number,
  cfg: SquadFlywheelConfig,
  seed: number,
): string {
  const base = cfg.bountyDescriptionTemplate?.trim() || pick(SQUAD_BOUNTY_DESC_TEMPLATES);
  const theme = THEMES[(seed + index) % THEMES.length] ?? pick(THEMES);
  return base.replace(/\{theme\}/gi, theme).replace(/\{handle\}/gi, account.xHandle).slice(0, 240);
}

async function verifyBountyVisible(page: Page, title: string): Promise<boolean> {
  await fillFirstVisibleLocator(page, SELECTORS.bountySearchInput, title).catch(() => null);
  await humanPause(page, 600, 1200);
  const hit = page.getByText(title, { exact: false }).first();
  return hit.isVisible().catch(() => false);
}

async function openBountyCreateForm(page: Page, account: SimclusterAccount, seed: number): Promise<boolean> {
  const openFromBounties = async () => {
    const opened = await clickFirstVisibleByRole(page, SELECTORS.bountyCreateButton);
    if (opened) return true;
    const explicitCreate = page
      .locator("button, a, [role='button'], [role='link']")
      .filter({ hasText: /create bounty|new bounty|set bounty|place bounty/i })
      .first();
    if (await explicitCreate.isVisible().catch(() => false)) {
      await explicitCreate.click({ timeout: 5000, force: true }).catch(() => null);
      return true;
    }
    return false;
  };

  if (await openFromBounties()) return true;

  const openedConcepts = await openSectionWithRoutes(
    page,
    [...SELECTORS.navConcepts, /new concept/i, /my concepts?/i],
    SECTION_ROUTES.concepts,
  );
  if (openedConcepts) {
    await humanPause(page, 700, 1400);
    if (await clickFirstVisibleByRole(page, [/set bounty/i, /create bounty/i, /place bounty/i])) {
      return true;
    }
  }

  // If concept-dependent bounty controls are hidden, bootstrap one concept and retry once.
  try {
    await taskCreateConcept(page, account, seed);
  } catch {
    // best effort
  }
  await openSectionWithRoutes(page, SELECTORS.navBounties, SECTION_ROUTES.bounties).catch(() => false);
  await humanPause(page, 600, 1200);
  return openFromBounties();
}

async function createSquadBounties(
  page: Page,
  account: SimclusterAccount,
  cycleDate: string,
  count: number,
  cfg: SquadFlywheelConfig,
  seed: number,
): Promise<{ created: number; createdTitles: string[] }> {
  const opened = await ensureBountiesSection(page);
  if (!opened) {
    await appendLog(`${account.xHandle} -> squad create skipped: could not open bounties section`, "warn");
    return { created: 0, createdTitles: [] };
  }
  let created = 0;
  const createdTitles: string[] = [];
  const accountTag = safeHandleTag(account.xHandle);

  for (let i = 1; i <= count; i += 1) {
    const title = `${SQUAD_BOUNTY_PREFIX}-${cycleDate}-${accountTag}-${String(i).padStart(2, "0")}`;
    await appendLog(`${account.xHandle} -> bounty create start: ${title}`, "info");
    const openedCreate = await openBountyCreateForm(page, account, seed + i);
    if (!openedCreate) {
      await appendLog(`${account.xHandle} -> bounty create failed: open form missing`, "warn");
      continue;
    }
    await humanPause(page, 700, 1600);

    const titleFilled = await fillFirstVisibleLocator(page, SELECTORS.bountyTitleInput, title);
    const descriptionFilled = await fillFirstVisibleLocator(
      page,
      SELECTORS.bountyDescriptionInput,
      resolveBountyDescription(account, i, cfg, seed),
    );
    await clickFirstVisibleByRole(page, [/latest concept/i, /owned/i, /my concepts?/i, /select concept/i]).catch(() => null);
    await humanPause(page, 700, 1800);

    const submitted = await clickFirstVisibleByRole(page, SELECTORS.bountySubmitButton);
    if (!submitted || !titleFilled || !descriptionFilled) {
      await appendLog(`${account.xHandle} -> bounty create failed: missing form controls for ${title}`, "warn");
      continue;
    }
    await humanPause(page, 1200, 2600);
    const verified = await verifyBountyVisible(page, title);
    if (verified) {
      created += 1;
      createdTitles.push(title);
      await appendLog(`${account.xHandle} -> bounty created: ${title}`, "success");
    } else {
      await appendLog(`${account.xHandle} -> bounty submit unverified: ${title}`, "warn");
    }
  }
  return { created, createdTitles };
}

async function farmSquadBounties(
  page: Page,
  account: SimclusterAccount,
  cycleDate: string,
  maxTargets: number,
  seed: number,
): Promise<{ farmed: number }> {
  const opened = await ensureBountiesSection(page);
  if (!opened) {
    await appendLog(`${account.xHandle} -> squad farm skipped: could not open bounties section`, "warn");
    return { farmed: 0 };
  }
  const searchToken = `${SQUAD_BOUNTY_PREFIX}-${cycleDate}`;
  await fillFirstVisibleLocator(page, SELECTORS.bountySearchInput, searchToken).catch(() => null);
  await humanPause(page, 900, 1800);

  let farmed = 0;
  for (let i = 0; i < maxTargets; i += 1) {
    const openedCard =
      (await clickFirstVisibleByRole(page, SELECTORS.bountyOpenCardButton)) ||
      (await clickFirstVisibleByRole(page, SELECTORS.bountyUseConceptButton));
    if (!openedCard) break;
    await humanPause(page, 900, 1800);

    await clickFirstVisibleByRole(page, SELECTORS.bountyUseConceptButton).catch(() => null);
    await runTask(page, account, seed + i, `Squad Bounty Post ${i + 1}`, taskCreatePost as TaskFn, { required: false });
    const claimed = await clickFirstVisibleByRole(page, SELECTORS.bountyClaimButton);
    if (claimed) {
      farmed += 1;
      await appendLog(`${account.xHandle} -> squad bounty farmed #${farmed}`, "success");
    }
    const reopened = await ensureBountiesSection(page);
    if (!reopened) break;
    await fillFirstVisibleLocator(page, SELECTORS.bountySearchInput, searchToken).catch(() => null);
    await humanPause(page, 700, 1400);
  }
  return { farmed };
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
  options?: { required?: boolean },
) {
  const required = options?.required ?? true;
  try {
    console.log(`[farm] ${account.xHandle} -> ${taskName} -> start`);
    await appendLog(`${account.xHandle} -> ${taskName} -> start`, "info");
    await task(page, account, seed);
    console.log(`[farm] ${account.xHandle} -> ${taskName} -> done`);
    await appendLog(`${account.xHandle} -> ${taskName} -> done`, "success");
    return true;
  } catch (error) {
    console.error(`[farm] ${account.xHandle} -> ${taskName} -> failed`, error);
    const detail = error instanceof Error ? error.message : String(error);
    await appendLog(`${account.xHandle} -> ${taskName} -> failed: ${detail}`, "warn");
    await safeShot(page, `${account.id}-${taskName.replace(/\s+/g, "-").toLowerCase()}-error`).catch(() => null);
    if (required) throw error;
    return false;
  }
}

function taskPlanForRun(): TaskDef[] {
  return [
    { name: "Daily Check-in", fn: taskDailyCheckIn as TaskFn, required: false },
    { name: "Missions", fn: taskMissions as TaskFn, required: false },
    { name: "Bounties", fn: taskBounties as TaskFn, required: false },
    { name: "Create Concept", fn: taskCreateConcept as TaskFn, required: false },
  ];
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
    runId: `${Date.now()}-unlock`,
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
export async function requestFarmStart(
  headed: boolean,
  configOverride?: Partial<SquadFlywheelConfig>,
): Promise<FarmStartResult> {
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
  const persistedConfig = await readSquadConfig();
  const squadConfig = normalizeSquadConfig({ ...persistedConfig, ...configOverride });
  const tasks = taskPlanForRun();
  const postsPerAccount = getPostsPerAccountTarget();
  const totalTasksPerAccount = squadConfig.enableSquadBountyFlywheel
    ? tasks.length + squadConfig.bountiesPerAccount * 2 + 1
    : tasks.length + postsPerAccount * 2 + 1;

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
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFarmStatus({
    ...defaultStatus(),
    running: true,
    runId,
    startedAt: started,
    lastFarmHeartbeatAt: started,
    totalAccounts: squadConfig.enableSquadBountyFlywheel ? rotated.length * 2 : rotated.length,
    squadConfig,
    bountyCycleDate: todayKeyUTC(),
    logs: [
      {
        ts: started,
        text: squadConfig.enableSquadBountyFlywheel
          ? `Farm started for ${rotated.length} account(s). Squad bounty flywheel enabled (${squadConfig.bountiesPerAccount} bounties/account).`
          : `Farm started for ${rotated.length} account(s), target ${postsPerAccount} post(s) per account.`,
        tone: "info",
      },
    ],
  });

  void runFarmAccountsJob(headed, runId, seed, rotated, updated, tasks, totalTasksPerAccount, postsPerAccount, squadConfig);

  return { ok: true };
}

/** @deprecated use requestFarmStart — kept for any direct callers */
export async function farmAllAccounts(headed: boolean = false) {
  await requestFarmStart(headed);
}

async function runFarmAccountsJob(
  headed: boolean,
  runId: string,
  seed: number,
  rotated: SimclusterAccount[],
  updated: SimclusterAccount[],
  tasks: TaskDef[],
  totalTasksPerAccount: number,
  postsPerAccount: number,
  squadConfig: SquadFlywheelConfig,
) {
  try {
  const isSuperseded = async () => {
    const s = await readFarmStatus();
    return s.runId !== runId || !s.running;
  };

  // One preflight launch prevents "first account fails" while deps are installed.
  const preflight = await launchChromiumWithSelfHeal(false);
  await preflight.close().catch(() => null);
  await appendLog("Browser runtime check passed.", "info");
  const cycleDate = todayKeyUTC();
  const totalUnits = squadConfig.enableSquadBountyFlywheel ? rotated.length * 2 : rotated.length;
  let completedUnits = 0;
  let totalBountiesCreated = 0;
  let totalBountiesFarmed = 0;

  const processAccount = async (account: SimclusterAccount, phase: "create" | "farm" | "standard") => {
    if (await isSuperseded()) return;
    const originalIndex = updated.findIndex((a) => a.id === account.id);
    if (originalIndex < 0) return;

    if (isFarmCooldownEnabled() && farmedInLast24h(updated[originalIndex].lastFarmed)) {
      await appendLog(`${account.xHandle} -> skipped (already farmed within last 24h)`, "warn");
      return;
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
      completedAccounts: completedUnits,
      overallProgress: Math.round((completedUnits / totalUnits) * 100),
      bountyCreatedCount: totalBountiesCreated,
      bountyFarmedCount: totalBountiesFarmed,
      estimatedCloutEarned: totalBountiesFarmed * 25 + totalBountiesCreated * 10,
    });
    await appendLog(`${account.xHandle} -> account session started (${phase})`, "info");

    let context: BrowserContext | null = null;
    let browser: Browser | null = null;
    let page: Page | null = null;
    const startedAt = Date.now();

    try {
      browser = await launchChromiumWithSelfHeal(headed);
      const token = typeof account.agentSessionToken === "string" ? account.agentSessionToken.trim() : "";
      const extraHTTPHeaders =
        token.length > 0
          ? {
              Authorization: `Bearer ${token}`,
              "X-Simcluster-Token": token,
            }
          : undefined;
      context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
      });
      if (Array.isArray(account.cookies) && account.cookies.length > 0) {
        await context.addCookies(account.cookies as Cookie[]);
      }

      page = await context.newPage();
      await page.goto("https://simcluster.ai", { waitUntil: "domcontentloaded", timeout: 60000 });
      await humanPause(page);

      if (/login|sign-?in|\/auth|\/signup/i.test(page.url())) {
        throw new Error("Simcluster opened sign-in page. Reconnect this account session.");
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

      let completedSteps = 0;
      if (phase !== "farm") {
        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
          if (await isSuperseded()) return;
          const task = tasks[taskIndex];
          await runTask(page, farmAccount, seed, task.name, task.fn, { required: false });
          completedSteps += 1;
          await patchStatus({ currentAccountProgress: Math.round((completedSteps / totalTasksPerAccount) * 100) });
        }
      }

      if (squadConfig.enableSquadBountyFlywheel && phase === "create") {
        if (isSameBountyCycle(updated[originalIndex].lastBountyCycle, cycleDate)) {
          await appendLog(`${farmAccount.xHandle} -> squad bounty creation already done today`, "info");
        } else {
          const created = await createSquadBounties(
            page,
            farmAccount,
            cycleDate,
            squadConfig.bountiesPerAccount,
            squadConfig,
            seed + originalIndex,
          );
          totalBountiesCreated += created.created;
          await patchStatus({
            bountyCreatedCount: totalBountiesCreated,
            estimatedCloutEarned: totalBountiesFarmed * 25 + totalBountiesCreated * 10,
          });
          await appendLog(
            `${farmAccount.xHandle} -> squad create phase done (${created.created}/${squadConfig.bountiesPerAccount})`,
            created.created > 0 ? "success" : "warn",
          );
        }
      } else if (squadConfig.enableSquadBountyFlywheel && phase === "farm") {
        const farmed = await farmSquadBounties(
          page,
          farmAccount,
          cycleDate,
          squadConfig.bountiesPerAccount * rotated.length,
          seed + originalIndex,
        );
        totalBountiesFarmed += farmed.farmed;
        await patchStatus({
          bountyFarmedCount: totalBountiesFarmed,
          estimatedCloutEarned: totalBountiesFarmed * 25 + totalBountiesCreated * 10,
        });
        updated[originalIndex] = {
          ...updated[originalIndex],
          lastBountyCycle: cycleDate,
        };
        await appendLog(`${farmAccount.xHandle} -> squad farm phase done (${farmed.farmed} bounty actions)`, "success");
      } else {
        let postsCompleted = 0;
        for (let postIndex = 0; postIndex < postsPerAccount; postIndex += 1) {
          if (await isSuperseded()) return;
          const postOk = await runTask(
            page,
            farmAccount,
            seed + postIndex,
            `Create Post ${postIndex + 1}/${postsPerAccount}`,
            taskCreatePost as TaskFn,
            { required: false },
          );
          if (postOk) postsCompleted += 1;
          completedSteps += 1;
          await patchStatus({ currentAccountProgress: Math.round((completedSteps / totalTasksPerAccount) * 100) });

          await runTask(
            page,
            farmAccount,
            seed + 100 + postIndex,
            `Light Engagement ${postIndex + 1}/${postsPerAccount}`,
            async (p) => {
              await taskLightEngagement(p, updated);
            },
            { required: false },
          );
          completedSteps += 1;
          await patchStatus({ currentAccountProgress: Math.round((completedSteps / totalTasksPerAccount) * 100) });
        }
        await appendLog(
          `${farmAccount.xHandle} -> posting sprint result: ${postsCompleted}/${postsPerAccount} post(s) completed`,
          postsCompleted > 0 ? "success" : "warn",
        );
        if (postsCompleted === 0) {
          throw new Error("No posts were created for this account.");
        }
      }

      await runTask(
        page,
        farmAccount,
        seed + 700,
        "Final Engagement Sweep",
        async (p) => {
          await taskLightEngagement(p, updated);
        },
        { required: false },
      );

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
      await appendLog(
        `${farmAccount.xHandle} -> completed -> +${updated[originalIndex].cloutEstimate ?? "?"} CLOUT est.`,
        "success",
      );
    } catch (error) {
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
    }
  };

  if (squadConfig.enableSquadBountyFlywheel) {
    await appendLog(`Squad bounty creation phase started (${squadConfig.bountiesPerAccount}/account).`, "info");
    for (let i = 0; i < rotated.length; i += 1) {
      if (await isSuperseded()) return;
      await processAccount(rotated[i], "create");
      completedUnits += 1;
      await patchStatus({
        completedAccounts: completedUnits,
        overallProgress: Math.round((completedUnits / totalUnits) * 100),
      });
    }

    await appendLog("Squad bounty farming phase started (all accounts farm squad bounties).", "info");
    for (let i = 0; i < rotated.length; i += 1) {
      if (await isSuperseded()) return;
      await processAccount(rotated[i], "farm");
      completedUnits += 1;
      await patchStatus({
        completedAccounts: completedUnits,
        overallProgress: Math.round((completedUnits / totalUnits) * 100),
      });
    }
  } else {
    for (let i = 0; i < rotated.length; i += 1) {
      if (await isSuperseded()) return;
      await processAccount(rotated[i], "standard");
      completedUnits += 1;
      await patchStatus({
        completedAccounts: completedUnits,
        overallProgress: Math.round((completedUnits / totalUnits) * 100),
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
    runId,
    finishedAt: finishedAt.toISOString(),
    nextFarmAt: nextFarmAtIso,
    currentAccountId: undefined,
    currentAccountHandle: undefined,
    currentAccountProgress: 100,
    overallProgress: 100,
    bountyCreatedCount: totalBountiesCreated,
    bountyFarmedCount: totalBountiesFarmed,
    estimatedCloutEarned: totalBountiesFarmed * 25 + totalBountiesCreated * 10,
    successMessage: squadConfig.enableSquadBountyFlywheel
      ? `✅ Squad created ${totalBountiesCreated} bounties • All accounts farmed squad bounties • massive clout loop complete`
      : `✅ AGENT FARM COMPLETE — ALL ${rotated.length} ACCOUNTS AT MAX DAILY CLOUT + NEW AI POSTS & IMAGES GENERATED`,
    logs: [
      ...(await readFarmStatus()).logs.slice(-59),
      {
        ts: nowIso(),
        text: squadConfig.enableSquadBountyFlywheel
          ? `Squad created ${totalBountiesCreated} bounties • farmed ${totalBountiesFarmed} squad bounties • loop complete.`
          : cooldownOn
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
      runId,
      finishedAt: nowIso(),
      logs: [
        ...s.logs.slice(-59),
        { ts: nowIso(), text: `Farm aborted unexpectedly: ${detail}`, tone: "warn" },
      ],
    });
  }
}

