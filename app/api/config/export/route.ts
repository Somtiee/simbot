import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { POST_TEMPLATES, SELECTORS, THEMES } from "@/lib/agentConfig";
import { readSquadConfig } from "@/lib/squadConfig";
import { serverPaths } from "@/lib/serverDataPaths";

const ACCOUNTS_FILE = serverPaths.accountsJson();
const STATUS_FILE = serverPaths.farmStatusJson();

export async function GET() {
  const [accountsRaw, statusRaw] = await Promise.all([
    fs.readFile(ACCOUNTS_FILE, "utf8").catch(() => "[]"),
    fs.readFile(STATUS_FILE, "utf8").catch(() => "{}"),
  ]);
  const squadConfig = await readSquadConfig();

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    accounts: JSON.parse(accountsRaw),
    farmStatus: JSON.parse(statusRaw),
    squadConfig,
    agentConfig: {
      THEMES,
      POST_TEMPLATES,
      SELECTORS,
    },
  });
}
