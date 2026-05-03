/**
 * When true: per-account 24h skip + global farm button lock after a full run.
 * Set FARM_COOLDOWN_ENABLED=1 (or true) on the server to restore production-style limits.
 * Default: off so you can run the farm repeatedly while testing.
 */
export function isFarmCooldownEnabled(): boolean {
  const v = process.env.FARM_COOLDOWN_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
