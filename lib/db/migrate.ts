// lib/db/migrate.ts (WP-DS02, DSD-05)
// The pure half of the migration runner. scripts/db-migrate.ts does the I/O. Kept apart so the
// tests can prove the plan (order, idempotence, drift) without a database.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
export const ROLES_FILE = "roles.sql";

export interface MigrationFile {
  name: string;
  sha256: string;
  sql: string;
}

export interface Applied {
  name: string;
  sha256: string;
}

export interface Plan {
  pending: MigrationFile[];
  drifted: string[]; // applied, but the file on disk has changed since
  unknown: string[]; // applied in the database, missing on disk
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// roles.sql first, then every numbered migration in order. roles.sql creates the app_user role
// and sets default privileges, so every table a numbered file creates is granted to the role as
// it is made. It runs first so that a later migration can take a privilege away again
// (0015_auth_wall.sql revokes the auth tables) without roles.sql's blanket grant undoing it on a
// fresh database. On a database where roles.sql already ran last (before 27 Sep), nothing changes:
// the ledger never runs a file twice, and a pending numbered file simply runs after it.
export function readMigrations(dbDir: string): MigrationFile[] {
  const dir = join(dbDir, "migrations");
  const numbered = readdirSync(dir).filter((f) => MIGRATION_RE.test(f)).sort();
  const files = numbered.map((name) => {
    const sql = readFileSync(join(dir, name), "utf8");
    return { name, sql, sha256: sha256(sql) };
  });
  const roles = readFileSync(join(dbDir, ROLES_FILE), "utf8");
  return [{ name: ROLES_FILE, sql: roles, sha256: sha256(roles) }, ...files];
}

export function plan(files: MigrationFile[], applied: Applied[]): Plan {
  const byName = new Map(applied.map((a) => [a.name, a.sha256]));
  const onDisk = new Set(files.map((f) => f.name));
  const pending = files.filter((f) => !byName.has(f.name));
  const drifted = files.filter((f) => byName.has(f.name) && byName.get(f.name) !== f.sha256).map((f) => f.name);
  const unknown = applied.map((a) => a.name).filter((n) => !onDisk.has(n));
  // Order only matters within one run: roles.sql, then the numbered files. A numbered file
  // pending after roles.sql ran is fine (default privileges cover it).
  return { pending, drifted, unknown };
}

// ALTER ROLE takes no bind parameters, so the literal is quoted here. Single quotes are
// doubled, and a password carrying a backslash or a NUL is refused rather than escaped.
export function alterPasswordSql(role: string, password: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("bad role name");
  if (password.length < 16) throw new Error("APP_USER_PASSWORD must be at least 16 characters");
  if (/[\\\u0000]/.test(password)) throw new Error("APP_USER_PASSWORD may not contain a backslash or NUL");
  return `alter role ${role} with login password '${password.replace(/'/g, "''")}'`;
}

export const LEDGER_DDL = `
  create table if not exists schema_migrations (
    name text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now()
  )`;
