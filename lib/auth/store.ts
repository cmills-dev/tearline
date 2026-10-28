// lib/auth/store.ts
// The user + session store: the durable backing for registration, login and revocation.
// It mirrors the seam pattern used by lib/store/tearSheetStore.ts - one interface, a
// Postgres implementation against db/migrations/0002_auth.sql, and an in-memory fallback
// used automatically when no database URL is set (the self-contained demo path).
//
// Sessions are DB-backed and revocable. The signed cookie envelope (lib/auth/session.ts)
// proves non-forgery cheaply in middleware; the session table here is authoritative and is
// what logout deletes. A session is addressed by an opaque token: only its HMAC fingerprint
// (token_hash) is stored, so the raw token is never at rest. createSession returns that
// token; loadSession / revokeSession take it back.
//
// The auth wall (db/migrations/0015_auth_wall.sql). The Postgres store never touches the TABLES
// app_user and session directly: the runtime ROLE app_user has no privilege on them. It calls six
// SECURITY DEFINER functions instead, each answering for one exact email or token hash:
// auth_find_user, auth_email_taken, auth_create_user, auth_session_create, auth_session_load and
// auth_session_revoke. So SQL run as the role cannot list users, hashes or sessions.
//
// The `postgres` client is loaded via a GUARDED DYNAMIC IMPORT, never a static dependency,
// exactly as lib/store/postgres.ts does, so the build passes without the optional peer dep.

import { randomUUID } from "crypto";
import { databaseUrl } from "@/lib/store/postgres";
import { inviteTokenHash, newInviteToken, newSessionToken, tokenFingerprint } from "./crypto";
import { authSecret } from "./session";

// The cookie carrying the opaque session token, kept alongside the signed envelope cookie so
// logout can revoke the exact server-side row. httpOnly; read only by the auth routes.
export const SESSION_HANDLE_COOKIE = "sid_h";

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string; // scrypt$salt$hash - never logged, never echoed
  tenantId: string;
}

export interface StoredAuthSession {
  userId: string;
  tenantId: string;
  expiresAt: Date;
}

export interface Tenant {
  id: string;
  name: string;
}

// An invite (WP-DS05, db/migrations/0014_invites.sql). The raw token is never stored.
export interface Invite {
  id: string;
  tenantId: string;
  email: string;
  expiresAt: Date;
  usedAt: Date | null;
}

// Why an invite could not be redeemed. The route shows one polite message for all but "exists",
// so a caller learns nothing about which tokens or emails are real.
export type RedeemFailure = "invalid" | "used" | "expired" | "email-mismatch" | "exists";
export type RedeemResult = { ok: true; user: AuthUser } | { ok: false; reason: RedeemFailure };

export const INVITE_TTL_DAYS = 7;

export interface AuthStore {
  createUser(email: string, passwordHash: string, tenantId: string): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  // Returns the opaque session token to place in the handle cookie.
  createSession(userId: string, tenantId: string, expiresAt: Date): Promise<string>;
  loadSession(token: string): Promise<StoredAuthSession | null>;
  revokeSession(token: string): Promise<void>;
  // A tenant by its id, or else by its name (case-insensitive). Throws if a name is ambiguous.
  findTenant(nameOrId: string): Promise<Tenant | null>;
  // A named tenant. Its id is the slug of the name. Throws if that id is taken.
  createTenant(name: string): Promise<Tenant>;
  // Returns the raw token for the link. Only its hash is kept.
  createInvite(tenantId: string, email: string, expiresAt: Date): Promise<{ token: string; invite: Invite }>;
  // In one step: check the token, the email and the expiry, create the user in the invite's
  // tenant, and mark the invite used. Nothing is written unless all of it succeeds.
  redeemInvite(token: string, email: string, passwordHash: string, now?: Date): Promise<RedeemResult>;
}

// The id a named tenant gets: lower case, letters, digits and dashes. "Demo" becomes "demo".
export function tenantSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// The checks every store makes before redeeming, so the two stores cannot drift.
function redeemCheck(invite: Invite | null, email: string, now: Date): RedeemFailure | null {
  if (!invite) return "invalid";
  if (invite.usedAt) return "used";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  if (invite.email !== email.toLowerCase()) return "email-mismatch";
  return null;
}

// ---- In-memory fallback (per-process, not durable) ----------------------------------------

export class InMemoryAuthStore implements AuthStore {
  private usersById = new Map<string, AuthUser>();
  private usersByEmail = new Map<string, AuthUser>();
  // Keyed by token fingerprint, mirroring the DB's token_hash primary key.
  private sessions = new Map<string, StoredAuthSession>();
  // Mirrors the tenant table. createUser adds its tenant as Postgres does (name = id).
  private tenants = new Map<string, Tenant>();
  // Keyed by token hash, mirroring invite.token_hash.
  private invites = new Map<string, Invite>();

  async createUser(email: string, passwordHash: string, tenantId: string): Promise<AuthUser> {
    const key = email.toLowerCase();
    if (this.usersByEmail.has(key)) {
      throw new Error("An account with that email already exists.");
    }
    if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, { id: tenantId, name: tenantId });
    const user: AuthUser = { id: randomUUID(), email: key, passwordHash, tenantId };
    this.usersById.set(user.id, user);
    this.usersByEmail.set(key, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    return this.usersByEmail.get(email.toLowerCase()) ?? null;
  }

  async createSession(userId: string, tenantId: string, expiresAt: Date): Promise<string> {
    const token = newSessionToken();
    const hash = tokenFingerprint(token, authSecret());
    this.sessions.set(hash, { userId, tenantId, expiresAt });
    return token;
  }

  async loadSession(token: string): Promise<StoredAuthSession | null> {
    const hash = tokenFingerprint(token, authSecret());
    const row = this.sessions.get(hash);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(hash);
      return null;
    }
    return row;
  }

  async revokeSession(token: string): Promise<void> {
    this.sessions.delete(tokenFingerprint(token, authSecret()));
  }

  async findTenant(nameOrId: string): Promise<Tenant | null> {
    const byId = this.tenants.get(nameOrId);
    if (byId) return byId;
    const wanted = nameOrId.trim().toLowerCase();
    const byName = [...this.tenants.values()].filter((t) => t.name.toLowerCase() === wanted);
    if (byName.length > 1) throw new Error(`More than one tenant is named "${nameOrId}". Use the tenant id.`);
    return byName[0] ?? null;
  }

  async createTenant(name: string): Promise<Tenant> {
    const id = tenantSlug(name);
    if (!id) throw new Error("A tenant name needs at least one letter or digit.");
    if (this.tenants.has(id)) throw new Error(`A tenant with id "${id}" already exists.`);
    const tenant: Tenant = { id, name: name.trim() };
    this.tenants.set(id, tenant);
    return tenant;
  }

  async createInvite(tenantId: string, email: string, expiresAt: Date): Promise<{ token: string; invite: Invite }> {
    if (!this.tenants.has(tenantId)) throw new Error(`No tenant with id "${tenantId}".`);
    const token = newInviteToken();
    const invite: Invite = { id: randomUUID(), tenantId, email: email.toLowerCase(), expiresAt, usedAt: null };
    this.invites.set(inviteTokenHash(token), invite);
    return { token, invite: { ...invite } };
  }

  async redeemInvite(token: string, email: string, passwordHash: string, now: Date = new Date()): Promise<RedeemResult> {
    const invite = this.invites.get(inviteTokenHash(token)) ?? null;
    const failure = redeemCheck(invite, email, now);
    if (failure) return { ok: false, reason: failure };
    if (this.usersByEmail.has(email.toLowerCase())) return { ok: false, reason: "exists" };
    const user = await this.createUser(email, passwordHash, invite!.tenantId);
    invite!.usedAt = now;
    return { ok: true, user };
  }
}

// ---- Postgres implementation (db/migrations/0002_auth.sql) ---------------------------------

// The minimal slice of the postgres.js client we use; kept local so no @types are needed for
// the optional peer dependency (identical shape to lib/store/postgres.ts).
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

// One Postgres pool per process, hung off globalThis so dev bundling does not open a fresh pool
// per route bundle (each pool holds real connections).
const sqlG = globalThis as unknown as { __authSql__?: Sql };

// Tests hand in a stand-in client (pg-mem behind a tagged template), so the SQL runs without a
// database. Null restores the real client on next use.
export function setAuthSqlForTests(sql: Sql | null): void {
  sqlG.__authSql__ = sql ?? undefined;
}

async function getSql(): Promise<Sql> {
  if (sqlG.__authSql__) return sqlG.__authSql__;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresAuthStore requires DATABASE_URL / POSTGRES_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlG.__authSql__ = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlG.__authSql__;
}

export class PostgresAuthStore implements AuthStore {
  async createUser(email: string, passwordHash: string, tenantId: string): Promise<AuthUser> {
    const sql = await getSql();
    const id = randomUUID();
    const key = email.toLowerCase();
    await sql.begin(async (tx) => {
      // app_user.tenant_id references tenant(id), so the tenant row must exist first.
      await tx`
        insert into tenant (id, name)
        values (${tenantId}, ${tenantId})
        on conflict (id) do nothing
      `;
      await tx`select auth_create_user(${id}, ${key}, ${passwordHash}, ${tenantId})`;
    });
    return { id, email: key, passwordHash, tenantId };
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const sql = await getSql();
    const rows = await sql`
      select id, email, password_hash, tenant_id
      from auth_find_user(${email.toLowerCase()})
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      email: String(r.email),
      passwordHash: String(r.password_hash),
      tenantId: String(r.tenant_id),
    };
  }

  async createSession(userId: string, tenantId: string, expiresAt: Date): Promise<string> {
    const sql = await getSql();
    const token = newSessionToken();
    const hash = tokenFingerprint(token, authSecret());
    await sql`select auth_session_create(${hash}, ${userId}, ${tenantId}, ${expiresAt})`;
    return token;
  }

  async loadSession(token: string): Promise<StoredAuthSession | null> {
    const sql = await getSql();
    const hash = tokenFingerprint(token, authSecret());
    const rows = await sql`
      select user_id, tenant_id, expires_at
      from auth_session_load(${hash})
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    const expiresAt = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at));
    if (expiresAt.getTime() <= Date.now()) {
      // Expired: clean it up and treat as absent.
      await sql`select auth_session_revoke(${hash})`;
      return null;
    }
    return { userId: String(r.user_id), tenantId: String(r.tenant_id), expiresAt };
  }

  async revokeSession(token: string): Promise<void> {
    const sql = await getSql();
    await sql`select auth_session_revoke(${tokenFingerprint(token, authSecret())})`;
  }

  // The tenant table carries no row-level security (0003 leaves it out), so no GUC is needed.
  async findTenant(nameOrId: string): Promise<Tenant | null> {
    const sql = await getSql();
    const rows = await sql`
      select id, name from tenant
      where id = ${nameOrId} or lower(name) = lower(${nameOrId.trim()})
    `;
    const all = rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
    const byId = all.find((t) => t.id === nameOrId);
    if (byId) return byId;
    if (all.length > 1) throw new Error(`More than one tenant is named "${nameOrId}". Use the tenant id.`);
    return all[0] ?? null;
  }

  async createTenant(name: string): Promise<Tenant> {
    const id = tenantSlug(name);
    if (!id) throw new Error("A tenant name needs at least one letter or digit.");
    const sql = await getSql();
    // Look first so the refusal does not rest on ON CONFLICT ... RETURNING alone (pg-mem, which
    // the tests use, returns the row on a conflict). The insert still guards a race.
    const taken = await sql`select id from tenant where id = ${id}`;
    if (taken.length > 0) throw new Error(`A tenant with id "${id}" already exists.`);
    const rows = await sql`
      insert into tenant (id, name) values (${id}, ${name.trim()})
      on conflict (id) do nothing
      returning id
    `;
    if (rows.length === 0) throw new Error(`A tenant with id "${id}" already exists.`);
    return { id, name: name.trim() };
  }

  async createInvite(tenantId: string, email: string, expiresAt: Date): Promise<{ token: string; invite: Invite }> {
    const sql = await getSql();
    const token = newInviteToken();
    const id = randomUUID();
    const key = email.toLowerCase();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`
        insert into invite (id, tenant_id, email, token_hash, expires_at)
        values (${id}, ${tenantId}, ${key}, ${inviteTokenHash(token)}, ${expiresAt})
      `;
    });
    return { token, invite: { id, tenantId, email: key, expiresAt, usedAt: null } };
  }

  // One transaction. The invite is found through app.invite_hash (the RLS policy in 0014 shows
  // that one row). Then app.tenant_id is pinned to the invite's tenant, the user is inserted,
  // and the invite is marked used only if it is still unused. A lost race rolls the user back.
  async redeemInvite(token: string, email: string, passwordHash: string, now: Date = new Date()): Promise<RedeemResult> {
    const sql = await getSql();
    const hash = inviteTokenHash(token);
    const key = email.toLowerCase();
    try {
      return await sql.begin(async (tx): Promise<RedeemResult> => {
        await tx`select set_config('app.invite_hash', ${hash}, true)`;
        const rows = await tx`
          select id, tenant_id, email, expires_at, used_at
          from invite
          where token_hash = ${hash}
          limit 1
        `;
        const r = rows[0];
        const invite: Invite | null = r
          ? {
              id: String(r.id),
              tenantId: String(r.tenant_id),
              email: String(r.email),
              expiresAt: r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at)),
              usedAt: r.used_at == null ? null : r.used_at instanceof Date ? r.used_at : new Date(String(r.used_at)),
            }
          : null;
        const failure = redeemCheck(invite, key, now);
        if (failure) return { ok: false, reason: failure };
        const taken = await tx`select auth_email_taken(${key}) as taken`;
        if (taken[0]?.taken === true) return { ok: false, reason: "exists" };

        await tx`select set_config('app.tenant_id', ${invite!.tenantId}, true)`;
        const userId = randomUUID();
        await tx`select auth_create_user(${userId}, ${key}, ${passwordHash}, ${invite!.tenantId})`;
        const marked = await tx`
          update invite set used_at = ${now}, used_by = ${userId}
          where id = ${invite!.id} and used_at is null
          returning id
        `;
        if (marked.length === 0) throw new InviteRaceError();
        return { ok: true, user: { id: userId, email: key, passwordHash, tenantId: invite!.tenantId } };
      });
    } catch (e) {
      // Another request redeemed the invite, or registered the email, between our read and our write.
      if (e instanceof InviteRaceError) return { ok: false, reason: "used" };
      if (/unique|duplicate/i.test(String((e as Error)?.message ?? e))) return { ok: false, reason: "exists" };
      throw e;
    }
  }
}

class InviteRaceError extends Error {
  constructor() {
    super("invite already used");
  }
}

// ---- Selection (mirrors lib/store/tearSheetStore.ts getStore) ------------------------------

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled separately,
// so a module-level singleton would give each bundle its own in-memory session store, and a session
// created by the login route would be invisible to getSession() on a page bundle - breaking auth in
// the keyless demo. globalThis is shared across every bundle in the one process. (With DATABASE_URL
// set the store is external, so this is moot.)
const g = globalThis as unknown as { __authStore__?: AuthStore | null };

// The durable Postgres store activates once a database URL is set; otherwise the in-memory
// store keeps registration and login working with nothing installed. Memoised per instance.
export function getAuthStore(): AuthStore {
  if (g.__authStore__) return g.__authStore__;
  g.__authStore__ = databaseUrl() ? new PostgresAuthStore() : new InMemoryAuthStore();
  return g.__authStore__;
}

// Test / boundary helper: drop the memoised store so a suite can re-read the env.
export function resetAuthStoreForTests(): void {
  g.__authStore__ = null;
}
