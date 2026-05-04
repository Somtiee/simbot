import { promises as fs } from "node:fs";
import path from "node:path";
import { serverPaths } from "@/lib/serverDataPaths";
import type { SquadFlywheelConfig } from "@/types";

const SQUAD_CONFIG_FILE = serverPaths.squadConfigJson();

export const DEFAULT_SQUAD_CONFIG: SquadFlywheelConfig = {
  enableSquadBountyFlywheel: false,
  bountiesPerAccount: 5,
  bountyDescriptionTemplate: "",
};

export function normalizeSquadConfig(input?: Partial<SquadFlywheelConfig>): SquadFlywheelConfig {
  const rawCount = Number(input?.bountiesPerAccount ?? DEFAULT_SQUAD_CONFIG.bountiesPerAccount);
  const bountiesPerAccount = Number.isFinite(rawCount) ? Math.max(4, Math.min(6, Math.floor(rawCount))) : 5;
  return {
    enableSquadBountyFlywheel: Boolean(
      input?.enableSquadBountyFlywheel ?? DEFAULT_SQUAD_CONFIG.enableSquadBountyFlywheel,
    ),
    bountiesPerAccount,
    bountyDescriptionTemplate: (input?.bountyDescriptionTemplate ?? "").trim(),
  };
}

export async function readSquadConfig(): Promise<SquadFlywheelConfig> {
  try {
    const raw = await fs.readFile(SQUAD_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SquadFlywheelConfig>;
    return normalizeSquadConfig(parsed);
  } catch {
    return DEFAULT_SQUAD_CONFIG;
  }
}

export async function writeSquadConfig(input: Partial<SquadFlywheelConfig>): Promise<SquadFlywheelConfig> {
  const current = await readSquadConfig();
  const merged = normalizeSquadConfig({ ...current, ...input });
  await fs.mkdir(path.dirname(SQUAD_CONFIG_FILE), { recursive: true });
  await fs.writeFile(SQUAD_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
