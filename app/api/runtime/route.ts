import { NextResponse } from "next/server";

/**
 * Client hints for features that need a local desktop (interactive Chrome).
 */
export async function GET() {
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
  return NextResponse.json({
    connectInteractiveAvailable: !onRailway,
    onRailway,
  });
}
