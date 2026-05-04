import { NextResponse } from "next/server";
import { readSquadConfig, writeSquadConfig } from "@/lib/squadConfig";
import type { SquadFlywheelConfig } from "@/types";

export async function GET() {
  try {
    const config = await readSquadConfig();
    return NextResponse.json({ ok: true, config });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<SquadFlywheelConfig>;
    const config = await writeSquadConfig(body);
    return NextResponse.json({ ok: true, config });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
