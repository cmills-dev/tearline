// lib/db/roleGuard.ts (WP-DS02, DSD-08)
// The owner-role guard. Row-level security is the MNPI wall, and the wall only holds when the
// app connects as a role the policies bind: not a superuser, no BYPASSRLS, and owner of no
// table. The Neon integration hands out its owner role by default, so a wrong env var is one
// paste away. This check asks the database who we are, and /api/health turns `ready` false and
// logs the reason when the answer is unsafe.
//
// judgeRole() is pure so the tests drive it. checkDbRole() runs the query, caches the verdict
// for a minute and never throws. It reveals no URL and no role name over the wire: health only
// carries the boolean.

import { databaseUrl } from "@/lib/store/postgres";

export interface RoleFacts {
  role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  ownedTables: number;
}

export interface RoleVerdict {
  // true: safe. false: connected, and the role bypasses the wall. null: no database, or it did
  // not answer, so nothing is known.
  safe: boolean | null;
  reasons: string[];
}

export function judgeRole(f: RoleFacts): RoleVerdict {
  const reasons: string[] = [];
  if (f.rolsuper) reasons.push(`role ${f.role} is a superuser`);
  if (f.rolbypassrls) reasons.push(`role ${f.role} has BYPASSRLS`);
  if (f.ownedTables > 0) reasons.push(`role ${f.role} owns ${f.ownedTables} table(s) in public`);
  return { safe: reasons.length === 0, reasons };
}

export const ROLE_QUERY = `
  select current_user::text as role, r.rolsuper, r.rolbypassrls,
    (select count(*) from pg_tables t where t.schemaname = 'public' and t.tableowner = current_user)::int as owned
  from pg_roles r where r.rolname = current_user`;

type Unsafe = { unsafe(q: string): Promise<Record<string, unknown>[]>; end(): Promise<void> };

let cached: { at: number; verdict: RoleVerdict } | null = null;
const TTL_MS = 60_000;
const TIMEOUT_MS = 3_000;

export async function checkDbRole(now: number = Date.now()): Promise<RoleVerdict> {
  const url = databaseUrl();
  if (!url) return { safe: null, reasons: ["no database configured"] };
  if (cached && now - cached.at < TTL_MS) return cached.verdict;

  let verdict: RoleVerdict;
  let sql: Unsafe | null = null;
  try {
    const mod = await import(/* webpackIgnore: true */ "postgres");
    const postgres = (mod.default ?? mod) as unknown as (u: string, o?: unknown) => Unsafe;
    sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3, prepare: false });
    const rows = await Promise.race([
      sql.unsafe(ROLE_QUERY),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("role check timed out")), TIMEOUT_MS)),
    ]);
    const r = rows[0];
    if (!r) {
      verdict = { safe: null, reasons: ["role check returned no row"] };
    } else {
      verdict = judgeRole({
        role: String(r.role),
        rolsuper: Boolean(r.rolsuper),
        rolbypassrls: Boolean(r.rolbypassrls),
        ownedTables: Number(r.owned),
      });
    }
  } catch (e) {
    verdict = { safe: null, reasons: [`database did not answer the role check: ${(e as Error).message}`] };
  } finally {
    if (sql) sql.end().catch(() => {});
  }
  if (verdict.safe !== true) {
    // The operator reads the reason in the logs. Never the URL.
    console.error(`[roleGuard] database role is not safe for the app: ${verdict.reasons.join("; ")}`);
  }
  cached = { at: now, verdict };
  return verdict;
}

// Readiness as health reports it: with a database configured, the role must be proven safe.
export function roleReady(v: RoleVerdict, dbConfigured: boolean): boolean {
  return dbConfigured ? v.safe === true : true;
}

export function _resetRoleCache(): void {
  cached = null;
}
