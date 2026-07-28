import { normalizeUsernameForRegistry } from "./chain/normalizeUsername.js";

export type UsernameRegistry = Map<string, `0x${string}`>;
export type GroupStore = Map<string, string[]>;

export type ResolverContext = {
  usernames: UsernameRegistry;
  groups: GroupStore;
};

const ADDR = (hex: string): `0x${string}` =>
  hex as `0x${string}`;

/** Default mock data for local dev & tests */
export function createDefaultRegistry(): ResolverContext {
  const usernames: UsernameRegistry = new Map([
    ["tolu", ADDR("0x1111111111111111111111111111111111111111")],
    ["ada", ADDR("0x2222222222222222222222222222222222222222")],
    ["john", ADDR("0x3333333333333333333333333333333333333333")],
  ]);
  const groups: GroupStore = new Map([
    ["friends", ["tolu", "ada", "john"]],
    ["family", ["tolu", "ada"]],
  ]);
  return { usernames, groups };
}

function normalizeUser(h: string): string {
  return h.replace(/^@/, "").toLowerCase();
}

function normalizeGroup(name: string): string {
  return name.trim().toLowerCase();
}

export function resolveUsername(
  ctx: ResolverContext,
  handle: string,
): { ok: true; username: string; address: `0x${string}` } | { ok: false; username: string } {
  const u = normalizeUser(handle);
  const address = ctx.usernames.get(u);
  if (!address) return { ok: false, username: u };
  return { ok: true, username: u, address };
}

export function resolveGroup(
  ctx: ResolverContext,
  name: string,
): { ok: true; name: string; members: string[] } | { ok: false; name: string } {
  const key = normalizeGroup(name);
  const members = ctx.groups.get(key);
  if (!members) return { ok: false, name: key };
  return { ok: true, name: key, members: [...members] };
}

export function createGroup(
  ctx: ResolverContext,
  displayName: string,
  memberHandles: string[],
): { ok: true; name: string; members: string[] } | { ok: false; reason: string } {
  const key = normalizeGroup(displayName);
  if (ctx.groups.has(key)) {
    return { ok: false, reason: `Group "${displayName}" already exists` };
  }
  const resolved: string[] = [];
  for (const h of memberHandles) {
    const r = resolveUsername(ctx, h);
    if (!r.ok) return { ok: false, reason: `Unknown username @${r.username}` };
    resolved.push(r.username);
  }
  ctx.groups.set(key, resolved);
  return { ok: true, name: key, members: resolved };
}

/** Mock: link username → wallet (one name per wallet). */
export function registerMockUsername(
  ctx: ResolverContext,
  rawName: string,
  wallet: `0x${string}`,
): { ok: true; username: string } | { ok: false; reason: string } {
  const norm = normalizeUsernameForRegistry(rawName);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  const n = norm.name;
  const taken = ctx.usernames.get(n);
  if (taken && taken.toLowerCase() !== wallet.toLowerCase()) {
    return {
      ok: false,
      reason: `Name @${n} is already linked to another wallet (mock).`,
    };
  }
  for (const [uname, addr] of ctx.usernames) {
    if (addr.toLowerCase() === wallet.toLowerCase() && uname !== n) {
      return {
        ok: false,
        reason: `This wallet already owns @${uname} in mock (one name per wallet).`,
      };
    }
  }
  ctx.usernames.set(n, wallet);
  return { ok: true, username: n };
}

export function isWalletRegisteredMock(
  ctx: ResolverContext,
  wallet: `0x${string}`,
): boolean {
  const w = wallet.toLowerCase();
  for (const addr of ctx.usernames.values()) {
    if (addr.toLowerCase() === w) return true;
  }
  return false;
}
