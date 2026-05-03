import { NextResponse } from "next/server";
import { getAccountConnectStatus } from "@/lib/accountConnector";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json(
      { ok: false, message: "accountId query param is required" },
      { status: 400 },
    );
  }

  const status = await getAccountConnectStatus(accountId);
  return NextResponse.json({ ok: true, status });
}
