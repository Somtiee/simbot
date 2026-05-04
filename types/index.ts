export type AccountStatus = "idle" | "farming" | "completed" | "error";

export interface SimclusterAccount {
  id: string;
  xHandle: string;
  discordHandle?: string;
  /** From Simcluster “agent connect” link code (POST /api/agent/session/exchange-code). Used for farming on Railway. */
  agentSessionToken?: string;
  // Required shape from prompt: Playwright cookie format can vary per source.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cookies: any[];
  lastFarmed?: string;
  /** YYYYMMDD key marking when this account last completed squad bounty cycle. */
  lastBountyCycle?: string;
  status: AccountStatus;
  cloutEstimate?: number;
  dailyRotationSeed?: number;
}

export interface SquadFlywheelConfig {
  enableSquadBountyFlywheel: boolean;
  bountiesPerAccount: number;
  bountyDescriptionTemplate?: string;
}
