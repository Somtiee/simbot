import { NextResponse } from "next/server";
import { farmAllAccounts } from "@/lib/farmEngine";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { headed?: boolean };
    const headed = Boolean(body.headed);

    void farmAllAccounts(headed);
    return NextResponse.json({ ok: true, started: true });
  } catch {
    return NextResponse.json({ ok: false, started: false }, { status: 500 });
  }
}
