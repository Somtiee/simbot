import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { POST_TEMPLATES, SELECTORS, THEMES } from "@/lib/agentConfig";

const ACCOUNTS_FILE = path.join(process.cwd(), "data", "accounts.json");
const STATUS_FILE = path.join(process.cwd(), "data", "farm-status.json");

export async function GET() {
  const [accountsRaw, statusRaw] = await Promise.all([
    fs.readFile(ACCOUNTS_FILE, "utf8").catch(() => "[]"),
    fs.readFile(STATUS_FILE, "utf8").catch(() => "{}"),
  ]);

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    accounts: JSON.parse(accountsRaw),
    farmStatus: JSON.parse(statusRaw),
    agentConfig: {
      THEMES,
      POST_TEMPLATES,
      SELECTORS,
    },
  });
}
