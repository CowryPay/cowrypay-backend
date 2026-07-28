/**
 * Database for the WhatsApp webhook flow.
 *
 * PERSISTENCE STRATEGY
 * ──────────────────────────────────────────────────────────────────────────────
 * User records (phone ↔ wallet ↔ username) are written to wallet-state.json
 * on every create/update so they survive server restarts.
 *
 * Ephemeral data (sessions, pending txs, vault cache) stays in-memory only —
 * these are intentionally short-lived and safe to lose on restart.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  User,
  Group,
  Intent,
  ResolvedPayment,
  PendingTxData,
  TxHistoryItem,
} from "../types.js";
import type { CachedOpportunity, PendingYieldDeposit } from "../lifi/types.js";

// ── Persistent wallet state file ──────────────────────────────────────────────
// Resolve relative to this source file so it works regardless of cwd
const STATE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../wallet-state.json");

type PersistedUser = {
  walletId:      string;
  walletAddress: string;
  username:      string;
};

type WalletState = {
  users: Record<string, PersistedUser>; // phone → PersistedUser
};

function loadState(): WalletState {
  if (!existsSync(STATE_FILE)) return { users: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as WalletState;
  } catch {
    console.warn("[DB] Failed to parse wallet-state.json — starting fresh");
    return { users: {} };
  }
}

function flushState(): void {
  const state: WalletState = { users: {} };
  for (const [phone, user] of users.entries()) {
    state.users[phone] = {
      walletId:      user.privyWalletId,
      walletAddress: user.walletAddress,
      username:      user.username,
    };
  }
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[DB] Failed to write wallet-state.json:", (err as Error).message);
  }
}

// ── In-memory stores ──────────────────────────────────────────────────────────
const users          = new Map<string, User>();              // phone → User
const byUsername     = new Map<string, string>();            // username → phone
const privyWalletIds = new Map<string, string>();            // phone → walletId

// Ephemeral (intentionally lost on restart)
const sessions       = new Map<string, OnboardingSession>();
const pendingTxs     = new Map<string, PendingTxData>();
const groupStore     = new Map<string, Group[]>();
const txHistoryStore = new Map<string, TxHistoryItem[]>();
const yieldOppCache  = new Map<string, CachedOpportunity[]>();

// ── Boot: reload users from disk ──────────────────────────────────────────────
{
  const state = loadState();
  let restored = 0;
  for (const [phone, p] of Object.entries(state.users)) {
    const user: User = {
      phone,
      username:      p.username,
      walletAddress: p.walletAddress,
      privyWalletId: p.walletId,
    };
    users.set(phone, user);
    byUsername.set(p.username.toLowerCase(), phone);
    privyWalletIds.set(phone, p.walletId);
    restored++;
  }
  if (restored > 0) {
    console.log(`[DB] Restored ${restored} user(s) from wallet-state.json`);
  }
}

type OnboardingSession = {
  step: "AWAIT_USERNAME" | "AWAIT_USERNAME_RECOVERY" | "AWAIT_SPLIT_NAMES" | "AWAIT_YIELD_CONFIRM" | string;
  intent?: Intent;
  walletAddress?: string;
  walletId?: string;
  yieldDeposit?: PendingYieldDeposit;
};

export const db = {
  // ── Users ─────────────────────────────────────────────────────────────────
  async getUserByPhone(phone: string): Promise<User | null> {
    return users.get(phone) ?? null;
  },

  async getUserByUsername(username: string): Promise<User | null> {
    const phone = byUsername.get(username.toLowerCase());
    if (!phone) return null;
    return users.get(phone) ?? null;
  },

  async createUser(u: User): Promise<void> {
    users.set(u.phone, u);
    byUsername.set(u.username.toLowerCase(), u.phone);
    privyWalletIds.set(u.phone, u.privyWalletId);
    flushState();
  },

  async updateUser(phone: string, updates: Partial<Pick<User, "walletAddress" | "privyWalletId" | "username">>): Promise<void> {
    const existing = users.get(phone);
    if (!existing) throw new Error(`No user found for phone ${phone}`);
    const updated = { ...existing, ...updates };
    users.set(phone, updated);
    if (updates.privyWalletId) privyWalletIds.set(phone, updates.privyWalletId);
    if (updates.username && updates.username !== existing.username) {
      byUsername.delete(existing.username.toLowerCase());
      byUsername.set(updates.username.toLowerCase(), phone);
    }
    flushState();
  },

  async isUsernameTaken(username: string): Promise<boolean> {
    return byUsername.has(username.toLowerCase());
  },

  // ── Onboarding sessions ───────────────────────────────────────────────────
  async getSession(phone: string): Promise<OnboardingSession | null> {
    return sessions.get(phone) ?? null;
  },

  async setSession(phone: string, session: OnboardingSession): Promise<void> {
    sessions.set(phone, session);
  },

  async clearSession(phone: string): Promise<void> {
    sessions.delete(phone);
  },

  // ── Pending transactions ──────────────────────────────────────────────────
  async getPendingTx(phone: string): Promise<PendingTxData | null> {
    return pendingTxs.get(phone) ?? null;
  },

  async setPendingTx(phone: string, data: PendingTxData): Promise<void> {
    pendingTxs.set(phone, data);
  },

  async clearPendingTx(phone: string): Promise<void> {
    pendingTxs.delete(phone);
  },

  // ── Privy wallet IDs ──────────────────────────────────────────────────────
  async getPrivyWalletId(phone: string): Promise<string | null> {
    return privyWalletIds.get(phone) ?? null;
  },

  async savePrivyWalletId(phone: string, walletId: string): Promise<void> {
    privyWalletIds.set(phone, walletId);
    const user = users.get(phone);
    if (user) {
      users.set(phone, { ...user, privyWalletId: walletId });
      flushState(); // persist whenever a wallet ID changes
    }
  },

  // ── Groups ────────────────────────────────────────────────────────────────
  async createGroup(data: {
    ownerPhone: string;
    name: string;
    members: { username: string; address: string }[];
  }): Promise<void> {
    const owned = groupStore.get(data.ownerPhone) ?? [];
    // Replace if a group with the same name already exists
    const idx = owned.findIndex(
      (g) => g.name.toLowerCase() === data.name.toLowerCase(),
    );
    const group: Group = {
      ownerPhone: data.ownerPhone,
      name: data.name,
      members: data.members,
    };
    if (idx >= 0) {
      owned[idx] = group;
    } else {
      owned.push(group);
    }
    groupStore.set(data.ownerPhone, owned);
  },

  async getGroupsByOwner(phone: string): Promise<Group[]> {
    return groupStore.get(phone) ?? [];
  },

  async getGroupByName(phone: string, groupName: string): Promise<Group | null> {
    const owned = groupStore.get(phone) ?? [];
    return (
      owned.find((g) => g.name.toLowerCase() === groupName.toLowerCase()) ??
      null
    );
  },

  async addGroupMember(
    phone: string,
    groupName: string,
    member: { username: string; address: string },
  ): Promise<Group | null> {
    const owned = groupStore.get(phone) ?? [];
    const group = owned.find(
      (g) => g.name.toLowerCase() === groupName.toLowerCase(),
    );
    if (!group) return null;
    // Avoid duplicate members
    if (!group.members.find((m) => m.username.toLowerCase() === member.username.toLowerCase())) {
      group.members.push(member);
    }
    return group;
  },

  async removeGroupMember(
    phone: string,
    groupName: string,
    username: string,
  ): Promise<Group | null> {
    const owned = groupStore.get(phone) ?? [];
    const group = owned.find(
      (g) => g.name.toLowerCase() === groupName.toLowerCase(),
    );
    if (!group) return null;
    const clean = username.replace("@", "").toLowerCase();
    group.members = group.members.filter(
      (m) => m.username.toLowerCase() !== clean,
    );
    return group;
  },

  // ── LI.FI yield opportunity cache ────────────────────────────────────────
  async saveYieldOpportunities(phone: string, opps: CachedOpportunity[]): Promise<void> {
    yieldOppCache.set(phone, opps);
  },

  async getYieldOpportunities(phone: string): Promise<CachedOpportunity[] | null> {
    return yieldOppCache.get(phone) ?? null;
  },

  async clearYieldOpportunities(phone: string): Promise<void> {
    yieldOppCache.delete(phone);
  },

  // ── Transaction history ───────────────────────────────────────────────────
  async saveTx(tx: {
    phone: string;
    txHash: string;
    intent: Intent;
    resolved: ResolvedPayment;
    timestamp: number;
  }): Promise<void> {
    const history = txHistoryStore.get(tx.phone) ?? [];
    history.unshift({ ...tx, status: "pending" });
    txHistoryStore.set(tx.phone, history);
  },

  async getTxHistory(phone: string, limit: number): Promise<TxHistoryItem[]> {
    return (txHistoryStore.get(phone) ?? []).slice(0, limit);
  },

  async getTxCountLastMinute(phone: string): Promise<number> {
    const cutoff = Date.now() - 60_000;
    const history = txHistoryStore.get(phone) ?? [];
    return history.filter((tx) => tx.timestamp >= cutoff).length;
  },
};
