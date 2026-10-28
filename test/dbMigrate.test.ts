// test/dbMigrate.test.ts (WP-DS02)
// The migration plan and the owner-role guard, both pure. The live half (a real Postgres, a
// second run that does nothing, the owner URL turning readiness false) is proven by
// scripts/local-preview.sh and recorded in docs/programme/evidence/local-preview.md.

import { resolve } from "node:path";
import { alterPasswordSql, plan, readMigrations, sha256 } from "../lib/db/migrate";
import { judgeRole, roleReady } from "../lib/db/roleGuard";
import { suite, test, assert, assertEqual, assertThrows } from "./harness";

const files = readMigrations(resolve(__dirname, "..", "db"));

suite("db-migrate plan (WP-DS02)");

test("roles.sql first, then the numbered migrations in order", () => {
  assert(files.length >= 16, "roles.sql and at least 0001..0015");
  assertEqual(files[0].name, "roles.sql", "roles.sql first, so a later migration's revoke is not undone by its blanket grant");
  assertEqual(files[1].name.slice(0, 4), "0001", "then 0001");
  const nums = files.slice(1).map((f) => f.name.slice(0, 4));
  assertEqual(nums.join(","), [...nums].sort().join(","), "sorted");
});

test("a database migrated before 27 Sep (roles.sql ran last) gets only the new file", () => {
  const before = files.filter((f) => f.name !== "0015_auth_wall.sql").map((f) => ({ name: f.name, sha256: f.sha256 }));
  const p = plan(files, before);
  assertEqual(p.pending.map((f) => f.name).join(), "0015_auth_wall.sql", "only 0015 pending");
  assertEqual(p.drifted.length, 0, "roles.sql unchanged, so no drift");
});

test("a fresh database has everything pending", () => {
  assertEqual(plan(files, []).pending.length, files.length, "all pending");
});

test("a second run does nothing", () => {
  const p = plan(files, files.map((f) => ({ name: f.name, sha256: f.sha256 })));
  assertEqual(p.pending.length, 0, "none pending");
  assertEqual(p.drifted.length, 0, "no drift");
});

test("an edited applied file is drift, an unknown row is reported", () => {
  const applied = files.map((f) => ({ name: f.name, sha256: f.name === "0003_rls.sql" ? sha256("old") : f.sha256 }));
  applied.push({ name: "9999_gone.sql", sha256: "x" });
  const p = plan(files, applied);
  assertEqual(p.drifted.join(), "0003_rls.sql", "drift named");
  assertEqual(p.unknown.join(), "9999_gone.sql", "unknown named");
});

test("the app_user password literal is quoted and weak ones refused", () => {
  assertEqual(alterPasswordSql("app_user", "it's-a-long-password"), "alter role app_user with login password 'it''s-a-long-password'", "quotes doubled");
  assertThrows(() => alterPasswordSql("app_user", "short"), "short refused");
  assertThrows(() => alterPasswordSql("app_user", "a-long-password-with\\backslash"), "backslash refused");
  assertThrows(() => alterPasswordSql("app_user; drop", "a-long-enough-password"), "role name checked");
});

suite("owner-role guard (WP-DS02)");

test("app_user is safe", () => {
  const v = judgeRole({ role: "app_user", rolsuper: false, rolbypassrls: false, ownedTables: 0 });
  assertEqual(v.safe, true, "safe");
  assert(roleReady(v, true), "ready");
});

test("the owner is not safe and readiness is false, with the reason", () => {
  const v = judgeRole({ role: "neondb_owner", rolsuper: false, rolbypassrls: true, ownedTables: 15 });
  assertEqual(v.safe, false, "unsafe");
  assert(!roleReady(v, true), "not ready");
  assert(v.reasons.some((r) => r.includes("owns 15")), "owner reason");
  assert(v.reasons.some((r) => r.includes("BYPASSRLS")), "bypass reason");
});

test("a superuser is not safe, and an unanswered check is not ready", () => {
  assertEqual(judgeRole({ role: "postgres", rolsuper: true, rolbypassrls: false, ownedTables: 0 }).safe, false, "super");
  assert(!roleReady({ safe: null, reasons: ["timeout"] }, true), "unknown is not ready");
  assert(roleReady({ safe: null, reasons: ["no database"] }, false), "no database: role is not the gate");
});
