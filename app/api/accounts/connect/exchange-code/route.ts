import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { exchangeAgentLinkCode } from "@/lib/simclusterExchange";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SimclusterAccount } from "@/types";

const accountsFile = serverPaths.accountsJson();

async function readAccounts(): Promise<SimclusterAccount[]> {
  try {
    const raw = await fs.readFile(accountsFile, "utf8");
    const parsed = JSON.parse(raw) as SimclusterAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAccounts(accounts: SimclusterAccount[]) {
  await fs.mkdir(path.dirname(accountsFile), { recursive: true });
  await fs.writeFile(accountsFile, JSON.stringify(accounts, null, 2), "utf8");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      accountId?: string;
      code?: string;
      xHandle?: string;
    };
    if (!body.accountId?.trim()) {
      return NextResponse.json({ ok: false, message: "accountId is required." }, { status: 400 });
    }
    if (!body.code?.trim()) {
      return NextResponse.json({ ok: false, message: "code is required." }, { status: 400 });
    }

    const exchanged = await exchangeAgentLinkCode(body.code);
    if (!exchanged.ok) {
      return NextResponse.json(
        { ok: false, message: exchanged.message },
        { status: exchanged.status >= 400 && exchanged.status < 600 ? exchanged.status : 400 },
      );
    }

    const accounts = await readAccounts();
    const id = body.accountId.trim();
    const idx = accounts.findIndex((a) => a.id === id);

    if (idx < 0) {
      const handle = body.xHandle?.trim() || `@${id}`;
      accounts.push({
        id,
        xHandle: handle,
        cookies: [],
        status: "idle",
        agentSessionToken: exchanged.token,
      });
    } else {
      accounts[idx] = {
        ...accounts[idx],
        agentSessionToken: exchanged.token,
        status: "idle",
      };
    }
    await writeAccounts(accounts);

    return NextResponse.json({
      ok: true,
      message: "Session linked. You can close the Simcluster tab and start farming.",
    });
  } catch {
    return NextResponse.json({ ok: false, message: "Server error during link." }, { status: 500 });
  }
}
