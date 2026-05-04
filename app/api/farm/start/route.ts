import { NextResponse } from "next/server";
import { requestFarmStart } from "@/lib/farmEngine";
import { writeSquadConfig } from "@/lib/squadConfig";
import type { SquadFlywheelConfig } from "@/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      headed?: boolean;
      squadConfig?: Partial<SquadFlywheelConfig>;
    };
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
    const headed = Boolean(body.headed) && !onRailway;
    const squadConfig = body.squadConfig ? await writeSquadConfig(body.squadConfig) : undefined;

    const result = await requestFarmStart(headed, squadConfig);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, started: false, message: result.message },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, started: true });
  } catch {
    return NextResponse.json({ ok: false, started: false }, { status: 500 });
  }
}
