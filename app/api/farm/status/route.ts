import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount } from "@/types";

const STATUS_FILE = serverPaths.farmStatusJson();
const ACCOUNTS_FILE = serverPaths.accountsJson();

export async function GET() {
  try {
    const [statusRaw, accountsRaw] = await Promise.all([
      fs.readFile(STATUS_FILE, "utf8").catch(() => "{}"),
      fs.readFile(ACCOUNTS_FILE, "utf8").catch(() => "[]"),
    ]);

    const status = JSON.parse(statusRaw) as Record<string, unknown>;
    const accounts = JSON.parse(accountsRaw) as SimclusterAccount[];
    return NextResponse.json({ ...status, accounts });
  } catch {
    return NextResponse.json({
      running: false,
      totalAccounts: 0,
      completedAccounts: 0,
      currentAccountProgress: 0,
      overallProgress: 0,
      logs: [],
      accounts: [],
    });
  }
}
