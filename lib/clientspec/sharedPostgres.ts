// lib/clientspec/sharedPostgres.ts
// The DURABLE SharedLearningStore for the RSI Phases 2 to 3 shared plane. Unlike
// lib/clientspec/postgres.ts, this store is GLOBAL: there is NO withRls / app.tenant_id here,
// because these tables (db/migrations/0008_shared_learning.sql) are shared ACROSS tenants and
// deliberately live OUTSIDE the row-level-security wall. That is only MNPI-safe because the
// tables are DE-IDENTIFIED: they store a normalised label, a concept key, a status, one-way
// tenant HASHES (for dedup), a distinct-tenant COUNT, and promoted dictionary versions - never
// a raw tenant id, never raw client wording beyond the normalised label, and never any figure.
//
// The `postgres` client is a GUARDED DYNAMIC IMPORT (mirror lib/store/postgres.ts) so the build
// passes without it installed; it activates only when DATABASE_URL is set (see
// getSharedLearningStore). Queries are plain (no transaction GUC) since there is no tenant to pin.

import type {
  CandidateStatus,
  SharedDictionaryEntry,
  SharedDictionaryVersion,
  SharedLearningStore,
  SynonymCandidate,
} from "./types";
import { databaseUrl } from "../store/postgres";
// One keyed-HMAC implementation, shared with the in-memory store, so both hash identically (see
// the sharedHash header for why a keyed hash, not a bare digest, is required).
import { hashTenantId } from "./sharedHash";
import { countsTowardK } from "./promote";

// The minimal slice of the postgres.js tagged-template client we use.
interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;
async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresSharedLearningStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

export class PostgresSharedLearningStore implements SharedLearningStore {
  async contribute(labelNorm: string, conceptKey: string, tenantId: string): Promise<void> {
    if (!countsTowardK(tenantId)) return; // an anonymous tenant is not an identity (promote.ts)
    const sql = await getSql();
    const tenantHash = hashTenantId(tenantId);
    // Upsert the contributor row idempotently: a tenant confirming twice is the same
    // (label_norm, concept_key, tenant_hash) primary key, so the distinct count never inflates.
    await sql`
      insert into synonym_candidate_contributor (label_norm, concept_key, tenant_hash)
      values (${labelNorm}, ${conceptKey}, ${tenantHash})
      on conflict (label_norm, concept_key, tenant_hash) do nothing
    `;
    // Ensure a candidate row exists as pending; do NOT downgrade an existing status.
    await sql`
      insert into synonym_candidate (label_norm, concept_key, status)
      values (${labelNorm}, ${conceptKey}, 'pending')
      on conflict (label_norm, concept_key) do nothing
    `;
  }

  async listCandidates(minTenants?: number): Promise<SynonymCandidate[]> {
    const sql = await getSql();
    // distinctTenants is the count of distinct contributor hashes for each candidate. A left
    // join keeps candidates that were seeded by setCandidateStatus with zero contributors.
    const rows = minTenants === undefined
      ? await sql`
          select c.label_norm, c.concept_key, c.status,
                 count(distinct k.tenant_hash) as distinct_tenants
          from synonym_candidate c
          left join synonym_candidate_contributor k
            on k.label_norm = c.label_norm and k.concept_key = c.concept_key
          group by c.label_norm, c.concept_key, c.status
        `
      : await sql`
          select c.label_norm, c.concept_key, c.status,
                 count(distinct k.tenant_hash) as distinct_tenants
          from synonym_candidate c
          left join synonym_candidate_contributor k
            on k.label_norm = c.label_norm and k.concept_key = c.concept_key
          group by c.label_norm, c.concept_key, c.status
          having count(distinct k.tenant_hash) >= ${minTenants}
        `;
    return rows.map((r) => ({
      labelNorm: r.label_norm as string,
      conceptKey: r.concept_key as string,
      distinctTenants: Number(r.distinct_tenants),
      status: r.status as CandidateStatus,
    }));
  }

  async setCandidateStatus(labelNorm: string, conceptKey: string, status: CandidateStatus): Promise<void> {
    const sql = await getSql();
    // Upsert so status can be set on a mapping seeded outside contribute (zero contributors).
    await sql`
      insert into synonym_candidate (label_norm, concept_key, status)
      values (${labelNorm}, ${conceptKey}, ${status})
      on conflict (label_norm, concept_key) do update set status = excluded.status
    `;
  }

  async activeEntries(): Promise<SharedDictionaryEntry[]> {
    const sql = await getSql();
    const rows = await sql`
      select entries from shared_dictionary_version
      order by version desc
      limit 1
    `;
    if (rows.length === 0) return [];
    return rows[0].entries as SharedDictionaryEntry[];
  }

  async activeVersion(): Promise<number> {
    const sql = await getSql();
    const rows = await sql`select coalesce(max(version), 0) as v from shared_dictionary_version`;
    return Number(rows[0].v);
  }

  async promote(entries: SharedDictionaryEntry[], approvedBy: string): Promise<number> {
    const sql = await getSql();
    const normalised = entries.map((e) => ({ labelNorm: e.labelNorm, conceptKey: e.conceptKey }));
    // Read-then-insert of `max(version)+1` is a race: two concurrent promotions could read the same
    // max and then one loses on the `version` primary key (or, without the PK, two rows collide). A
    // transaction-scoped advisory lock serialises promotions so each gets the next sequential
    // version. The lock releases automatically at commit/rollback; it does not block reads.
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('shared_dictionary_version_promote'))`;
      const rows = await tx`select coalesce(max(version), 0) + 1 as next from shared_dictionary_version`;
      const version = Number(rows[0].next);
      await tx`
        insert into shared_dictionary_version (version, entries, approved_by, created_at)
        values (${version}, ${tx.json(normalised)}, ${approvedBy}, now())
      `;
      return version;
    });
  }

  async listVersions(): Promise<SharedDictionaryVersion[]> {
    const sql = await getSql();
    const rows = await sql`
      select version, entries, approved_by, created_at
      from shared_dictionary_version
      order by version desc
    `;
    return rows.map((r) => ({
      version: Number(r.version),
      entries: r.entries as SharedDictionaryEntry[],
      approvedBy: r.approved_by as string,
      createdAt: new Date(r.created_at as string | Date).toISOString(),
    }));
  }
}
