"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SimclusterAccount } from "@/types";

interface AccountsState {
  accounts: SimclusterAccount[];
  enableSquadBountyFlywheel: boolean;
  bountiesPerAccount: number;
  bountyDescriptionTemplate: string;
  setAccounts: (accounts: SimclusterAccount[]) => void;
  addAccount: (account: SimclusterAccount) => void;
  updateAccount: (id: string, patch: Partial<SimclusterAccount>) => void;
  removeAccount: (id: string) => void;
  setEnableSquadBountyFlywheel: (enabled: boolean) => void;
  setBountiesPerAccount: (count: number) => void;
  setBountyDescriptionTemplate: (template: string) => void;
  rotateAccountsDaily: () => void;
  hydrateFromJson: () => Promise<void>;
  persistToJson: () => Promise<void>;
}

const persistAccountsSnapshot = async (accounts: SimclusterAccount[]) => {
  await fetch("/api/accounts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(accounts),
  });
};

const daySeed = () => {
  const now = new Date();
  return Number(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`,
  );
};

const shuffle = <T>(items: T[]): T[] => {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
};

const initialAccounts: SimclusterAccount[] = [
  { id: "acct-1", xHandle: "@0xVincentee", cookies: [], status: "farming", lastFarmed: "2m ago", cloutEstimate: 420 },
  { id: "acct-2", xHandle: "@arb_waifu", cookies: [], status: "farming", lastFarmed: "4m ago", cloutEstimate: 190 },
  { id: "acct-3", xHandle: "@nostalgia_degen", cookies: [], status: "idle", lastFarmed: "13m ago", cloutEstimate: 160 },
  { id: "acct-4", xHandle: "@cloutminer9000", cookies: [], status: "completed", lastFarmed: "1m ago", cloutEstimate: 510 },
  { id: "acct-5", xHandle: "@gaslesswizard", cookies: [], status: "farming", lastFarmed: "6m ago", cloutEstimate: 245 },
  { id: "acct-6", xHandle: "@zkposthuman", cookies: [], status: "error", lastFarmed: "19m ago", cloutEstimate: 92 },
  { id: "acct-7", xHandle: "@memetic_farm", cookies: [], status: "farming", lastFarmed: "3m ago", cloutEstimate: 320 },
  { id: "acct-8", xHandle: "@yieldtherapy", cookies: [], status: "idle", lastFarmed: "11m ago", cloutEstimate: 140 },
  { id: "acct-9", xHandle: "@simcluster_og", cookies: [], status: "farming", lastFarmed: "1m ago", cloutEstimate: 480 },
];

export const useFarmStore = create<AccountsState>()(
  persist(
    (set, get) => ({
      accounts: initialAccounts,
      enableSquadBountyFlywheel: false,
      bountiesPerAccount: 5,
      bountyDescriptionTemplate: "",
      setAccounts: (accounts) => {
        set({ accounts });
        void persistAccountsSnapshot(accounts);
      },
      addAccount: (account) =>
        set((state) => {
          const nextAccounts = [...state.accounts, account];
          void persistAccountsSnapshot(nextAccounts);
          return { accounts: nextAccounts };
        }),
      updateAccount: (id, patch) =>
        set((state) => {
          const nextAccounts = state.accounts.map((account) =>
            account.id === id ? { ...account, ...patch } : account,
          );
          void persistAccountsSnapshot(nextAccounts);
          return { accounts: nextAccounts };
        }),
      removeAccount: (id) =>
        set((state) => {
          const nextAccounts = state.accounts.filter((account) => account.id !== id);
          void persistAccountsSnapshot(nextAccounts);
          return { accounts: nextAccounts };
        }),
      setEnableSquadBountyFlywheel: (enabled) => set({ enableSquadBountyFlywheel: enabled }),
      setBountiesPerAccount: (count) => set({ bountiesPerAccount: Math.max(4, Math.min(6, Math.floor(count))) }),
      setBountyDescriptionTemplate: (template) => set({ bountyDescriptionTemplate: template }),
      rotateAccountsDaily: () =>
        set((state) => {
          const seed = daySeed();
          const rotated = shuffle(state.accounts).map((account, index) => ({
            ...account,
            dailyRotationSeed: seed + index,
          }));
          void persistAccountsSnapshot(rotated);
          return { accounts: rotated };
        }),
      hydrateFromJson: async () => {
        const response = await fetch("/api/accounts", { method: "GET" });
        if (!response.ok) return;
        const payload = (await response.json()) as SimclusterAccount[];
        const seed = daySeed();
        const shouldRotate = payload.some((account) =>
          typeof account.dailyRotationSeed !== "number" ||
          Math.floor(account.dailyRotationSeed / 100) !== Math.floor(seed / 100),
        );
        const hydrated = shouldRotate
          ? shuffle(payload).map((account, index) => ({
              ...account,
              dailyRotationSeed: seed + index,
            }))
          : payload;
        set({ accounts: hydrated });
        void persistAccountsSnapshot(hydrated);
      },
      persistToJson: async () => {
        const { accounts } = get();
        await fetch("/api/accounts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(accounts),
        });
      },
    }),
    {
      name: "simcluster-accounts",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export const useAccountsStore = useFarmStore;
