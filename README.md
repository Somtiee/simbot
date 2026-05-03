# Simcluster Agent Farmer

Cyber-themed multi-account farming dashboard + Playwright automation engine for `simcluster.ai`.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Core Flow

1. Manage accounts in the sidebar (supports unlimited accounts).
2. Connect each account session with **Connect Account** (Chrome profile-based).
3. Toggle runtime options (headed mode, random order, safety toggles).
4. Click **ACTIVATE AGENT FARM** or press `Ctrl/Cmd + Shift + F`.
5. Track live logs + per-account/overall progress.
6. On completion, cooldown starts (24h), and farm button locks until countdown ends.

## Data + Persistence

- Accounts source of truth: `data/accounts.json` (or `$DATA_DIR/accounts.json` on Railway)
- Farm runtime status/logs: `data/farm-status.json`
- Connect status: `data/connect-status.json`
- Client state: Zustand (`localStorage`) in `lib/store.ts`
- **Environment:** set `DATA_DIR` to an absolute path (e.g. `/data`) so all server routes + farm engine write to a mounted volume. Optional: `ARTIFACTS_DIR` for screenshot output.
- Auto-save behavior:
  - Add/update/remove/rotate/set accounts auto-write to `accounts.json`
  - Engine updates status + account outcomes continuously while running

## Deploy on Railway (Hobby)

### A. Create / link the service

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → select **`Somtiee/simbot`**.
2. Wait for the first deploy (Nixpacks). This repo includes **`nixpacks.toml`** so the build runs `npx playwright install --with-deps chromium` then `next build`.
3. If Railway does not pick up `nixpacks.toml`, set **Settings → Build → Custom Build Command** to:  
   `npm run build:railway`

### B. Persist `data/` with a volume (do this in the Railway UI)

1. Open your **Web** service (the Next.js app).
2. Go to the **Volumes** tab (or **Settings → Volumes**, depending on Railway UI version).
3. Click **Add volume** / **New volume**.
4. **Mount path:** enter **`/data`** (recommended).
5. Save and **redeploy** the service so the container starts with the volume mounted.

### C. Point the app at the volume

1. Open the service → **Variables** (or **Settings → Variables**).
2. Add:
   - **`DATA_DIR`** = `/data`  
   (must match the volume mount path exactly.)
3. Optional: **`ARTIFACTS_DIR`** = `/data/artifacts` if you want error screenshots on the volume too.
4. Redeploy again.

All server code now resolves paths via `lib/serverDataPaths.ts`, so `accounts.json`, `farm-status.json`, and `connect-status.json` live under `DATA_DIR` when set.

### D. Start command

Default is fine: **`npm run start`** (`next start`). Railway injects **`PORT`** automatically.

### E. Health check

In service settings, set health check path to **`/`** (expect **200**).

### F. Public URL

**Networking** → generate a **`*.up.railway.app`** domain (or attach a custom domain). HTTPS is automatic.

### G. Linux / headless note

Farm and cookie-test use Playwright. **Connect Account** (headed Chrome on your PC) is easiest locally; on Railway Linux, farming is typically **headless**. If Playwright still fails at runtime, check **Observability → Logs** for missing system libraries and bump **memory** in service settings.

## API Endpoints

- `POST /api/farm/start` - start a farm run
- `GET /api/farm/status` - poll real-time status + logs + current accounts
- `POST /api/accounts/connect/start` - start interactive profile-based account connect
- `GET /api/accounts/connect/status?accountId=...` - poll account connect status
- `GET /api/config/export` - full backup export (accounts + status + agent config)
- `GET|POST /api/accounts` - account persistence
- `POST /api/cookies/test-login` - headed cookie login validation

## Connect Existing Chrome Profiles

If each Simcluster account already lives in a separate Chrome profile:

1. In sidebar, click **Connect Account** for the matching handle.
2. Pick browser (`Chrome` or `Edge`) and enter its user data path:
   - Chrome: `C:\Users\<YOU>\AppData\Local\Google\Chrome\User Data`
   - Edge: `C:\Users\<YOU>\AppData\Local\Microsoft\Edge\User Data`
3. Enter profile directory (`Default`, `Profile 1`, `Profile 2`, ...).
4. Start connect flow and complete/confirm login in the opened browser window.
5. Wait for status: `Connected successfully. Session captured and saved.`

## Updating Selectors When UI Changes

Primary selector maps are text-first and intended to be easy to tweak:

- `lib/farmEngine.ts` -> `SELECTORS` for farming task actions
- `lib/agentConfig.ts` -> `SELECTORS` for shared UI/action hooks

When `simcluster.ai` UI changes:

1. Update role/text regex selectors first (preferred).
2. Keep fallback selectors broad but safe (`claim|generate|post|daily` style).
3. Run a headed test farm (`headed=true`) and watch logs.
4. If a task fails, inspect screenshot artifacts under `ARTIFACTS_DIR` (default: `artifacts/farm-errors`).

## Safety Guards

- One farm per 24h per account (`lastFarmed` guard in engine)
- Global cooldown lock after a full farm run
- Per-task try/catch with continue-on-failure
- Error boundary page fallback (`app/error.tsx`)
- Crash retry modal in dashboard for failed task runs

## Notes

- Use the **Full Backup / Export Config** button before large selector edits.
- Placeholder accounts are seeded with empty cookies; add real cookie payloads per account before farming.
