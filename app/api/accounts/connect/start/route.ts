import { NextResponse } from "next/server";
import { startAccountConnect } from "@/lib/accountConnector";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      accountId?: string;
      xHandle?: string;
      profilePath?: string;
      profileDirectory?: string;
      browser?: "chrome" | "edge";
      interactive?: boolean;
    };
    if (!body.accountId || !body.profilePath) {
      return NextResponse.json(
        { ok: false, message: "accountId and profilePath are required" },
        { status: 400 },
      );
    }

    void startAccountConnect({
      accountId: body.accountId,
      xHandle: body.xHandle,
      profilePath: body.profilePath,
      profileDirectory: body.profileDirectory,
      browser: body.browser ?? "chrome",
      interactive: body.interactive ?? true,
    });

    return NextResponse.json({ ok: true, started: true });
  } catch {
    return NextResponse.json({ ok: false, started: false }, { status: 500 });
  }
}
