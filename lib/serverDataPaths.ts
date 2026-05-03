import path from "node:path";

/**
 * Root directory for persisted JSON (accounts, farm status, connect status).
 * Set DATA_DIR on Railway to your volume mount (e.g. /data) so data survives redeploys.
 */
export function getDataDir(): string {
  const raw = process.env.DATA_DIR?.trim();
  if (raw) return path.resolve(raw);
  return path.join(process.cwd(), "data");
}

/**
 * Screenshots on farm errors. Override with ARTIFACTS_DIR if needed.
 */
export function getArtifactsDir(): string {
  const raw = process.env.ARTIFACTS_DIR?.trim();
  if (raw) return path.resolve(raw);
  return path.join(process.cwd(), "artifacts");
}

export const serverPaths = {
  accountsJson: () => path.join(getDataDir(), "accounts.json"),
  farmStatusJson: () => path.join(getDataDir(), "farm-status.json"),
  connectStatusJson: () => path.join(getDataDir(), "connect-status.json"),
  farmErrorShotsDir: () => path.join(getArtifactsDir(), "farm-errors"),
} as const;
