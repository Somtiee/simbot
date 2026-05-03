import { NextResponse } from "next/server";
import { clearFarmRunningLock } from "@/lib/farmEngine";

export async function POST() {
  try {
    await clearFarmRunningLock();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
