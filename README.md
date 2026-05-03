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
2. Toggle runtime options (headed mode, random order, safety toggles).
3. Click **ACTIVATE AGENT FARM** or press `Ctrl/Cmd + Shift + F`.
4. Track live logs + per-account/overall progress.
5. On completion, cooldown starts (24h), and farm button locks until countdown ends.

## Data + Persistence

- Accounts source of truth: `data/accounts.json`
- Farm runtime status/logs: `data/farm-status.json`
- Client state: Zustand (`localStorage`) in `lib/store.ts`
- Auto-save behavior:
  - Add/update/remove/rotate/set accounts auto-write to `accounts.json`
  - Engine updates status + account outcomes continuously while running

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
4. If a task fails, inspect screenshot artifacts in `artifacts/farm-errors`.

## Safety Guards

- One farm per 24h per account (`lastFarmed` guard in engine)
- Global cooldown lock after a full farm run
- Per-task try/catch with continue-on-failure
- Error boundary page fallback (`app/error.tsx`)
- Crash retry modal in dashboard for failed task runs

## Notes

- Use the **Full Backup / Export Config** button before large selector edits.
- Placeholder accounts are seeded with empty cookies; add real cookie payloads per account before farming.
