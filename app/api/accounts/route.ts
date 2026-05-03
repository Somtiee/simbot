import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount } from "@/types";

const accountsFile = serverPaths.accountsJson();

export async function GET() {
  try {
    const raw = await fs.readFile(accountsFile, "utf8");
    const parsed = JSON.parse(raw) as SimclusterAccount[];
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as SimclusterAccount[];
    await fs.mkdir(path.dirname(accountsFile), { recursive: true });
    await fs.writeFile(accountsFile, JSON.stringify(payload, null, 2), "utf8");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
