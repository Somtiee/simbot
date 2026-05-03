import { chromium } from "playwright";
import { NextResponse } from "next/server";

type CookieShape = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export async function POST(request: Request) {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    const body = (await request.json()) as { cookies?: CookieShape[] };
    const cookies = Array.isArray(body.cookies) ? body.cookies : [];
    const simclusterCookies = cookies.filter((cookie) =>
      cookie.domain?.toLowerCase().includes("simcluster.ai"),
    );

    if (simclusterCookies.length === 0) {
      return NextResponse.json({
        ok: false,
        message: "No valid simcluster.ai cookies found.",
      });
    }

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    await context.addCookies(
      simclusterCookies.map((cookie) => ({
        ...cookie,
        path: cookie.path ?? "/",
      })),
    );

    const page = await context.newPage();
    await page.goto("https://simcluster.ai", { waitUntil: "domcontentloaded", timeout: 45000 });

    const currentUrl = page.url();
    const effectiveCookies = await context.cookies("https://simcluster.ai");
    const hasSession = effectiveCookies.some(
      (cookie) => cookie.name.includes("session") || cookie.name.includes("auth"),
    );

    await page.waitForTimeout(2500);
    await browser.close();
    browser = null;

    if (currentUrl.includes("login") || !hasSession) {
      return NextResponse.json({
        ok: false,
        message: "Cookies loaded, but login may not be valid yet.",
      });
    }

    return NextResponse.json({
      ok: true,
      message: "Headed browser test succeeded on simcluster.ai.",
    });
  } catch {
    if (browser) await browser.close();
    return NextResponse.json(
      {
        ok: false,
        message: "Unable to run headed login test in current environment.",
      },
      { status: 500 },
    );
  }
}
