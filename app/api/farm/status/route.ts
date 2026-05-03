import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { SimclusterAccount } from "@/types";

const STATUS_FILE = path.join(process.cwd(), "data", "farm-status.json");
const ACCOUNTS_FILE = path.join(process.cwd(), "data", "accounts.json");

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
