// lib/clientspec/postgres.ts
// The DURABLE ClientSpecStore, mirroring lib/store/shortlistPostgres.ts: the `postgres` client
// is a GUARDED DYNAMIC IMPORT so the build passes without it installed, and it activates only
// when DATABASE_URL is set (see getClientSpecStore). It implements the same seam
// InMemoryClientSpecStore does, against the client_spec and onboarding_state tables in
// db/migrations/0006_clientspec.sql. Every method runs inside a transaction that pins
// app.tenant_id, so row-level security enforces tenant isolation on the database, not only in
// the WHERE clause.

import type { ClientSpec, ClientSpecStore, ClientSynonym, FeedbackEvent, OnboardingState } from "./types";
import { emptyOnboardingState } from "./types";
import { databaseUrl } from "../store/postgres";

export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;

// Tests hand in a stand-in client, so the SQL the store sends can be exercised without a database.
export function setClientSpecSqlForTests(sql: Sql | null): void {
  sqlSingleton = sql;
}
async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresClientSpecStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

async function withRls<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export class PostgresClientSpecStore implements ClientSpecStore {
  async saveSpec(tenantId: string, spec: ClientSpec): Promise<number> {
    return withRls(tenantId, async (tx) => {
      // Tenant must exist before any row that references it.
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
      // Two saves at once used to read the same max(version) under READ COMMITTED, and the second
      // insert then hit the primary key and returned a 500 (WP-QA03, WP-QA05). Locking the tenant
      // row first queues the second save behind the first, so it reads the first one's version.
      await tx`select id from tenant where id = ${tenantId} for update`;
      // Next version is the max version this tenant has ever saved, plus one (so the first
      // spec is version 1). coalesce handles the tenant's very first save.
      const rows = await tx`
        select coalesce(max(version), 0) + 1 as next
        from client_spec
        where tenant_id = ${tenantId}
      `;
      const version = Number(rows[0].next);
      // The spec's own `version` field is overwritten with the assigned version, so the
      // stored jsonb agrees with its primary key.
      const record: ClientSpec = { ...spec, version };
      await tx`
        insert into client_spec (tenant_id, version, spec, created_at)
        values (${tenantId}, ${version}, ${tx.json(record)}, now())
      `;
      return version;
    });
  }

  async listSpecs(tenantId: string): Promise<ClientSpec[]> {
    const rows = await withRls(tenantId, (tx) => tx`
      select spec from client_spec
      where tenant_id = ${tenantId}
      order by version desc
    `);
    return rows.map((r) => r.spec as ClientSpec);
  }

  async getActiveSpec(tenantId: string): Promise<ClientSpec | null> {
    const state = await this.getState(tenantId);
    if (state.activeSpecVersion === null) return null;
    const rows = await withRls(tenantId, (tx) => tx`
      select spec from client_spec
      where tenant_id = ${tenantId} and version = ${state.activeSpecVersion}
      limit 1
    `);
    if (rows.length === 0) return null;
    return rows[0].spec as ClientSpec;
  }

  async setActiveSpec(tenantId: string, version: number): Promise<void> {
    const state = await this.getState(tenantId);
    await this.setState(tenantId, { ...state, activeSpecVersion: version });
  }

  async getState(tenantId: string): Promise<OnboardingState> {
    const rows = await withRls(tenantId, (tx) => tx`
      select state from onboarding_state
      where tenant_id = ${tenantId}
      limit 1
    `);
    // A fresh tenant with no stored state gets an empty state, never null.
    if (rows.length === 0) return emptyOnboardingState(tenantId);
    return rows[0].state as OnboardingState;
  }

  async setState(tenantId: string, state: OnboardingState): Promise<void> {
    const record: OnboardingState = { ...state, updatedAt: new Date().toISOString() };
    await withRls(tenantId, async (tx) => {
      // Tenant must exist before any row that references it.
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
      await tx`
        insert into onboarding_state (tenant_id, state, updated_at)
        values (${tenantId}, ${tx.json(record)}, ${record.updatedAt})
        on conflict (tenant_id)
        do update set state = excluded.state, updated_at = excluded.updated_at
      `;
    });
  }

  async addSynonym(tenantId: string, syn: ClientSynonym): Promise<void> {
    await withRls(tenantId, async (tx) => {
      // Tenant must exist before any row that references it.
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
      // Upsert by (tenant_id, label_norm): latest write wins, overwriting concept, source and time.
      await tx`
        insert into client_synonym (tenant_id, label_norm, concept_key, source_label, confirmed_at)
        values (${tenantId}, ${syn.labelNorm}, ${syn.conceptKey}, ${syn.sourceLabel}, ${syn.confirmedAt})
        on conflict (tenant_id, label_norm)
        do update set concept_key = excluded.concept_key,
                      source_label = excluded.source_label,
                      confirmed_at = excluded.confirmed_at
      `;
    });
  }

  async listSynonyms(tenantId: string): Promise<ClientSynonym[]> {
    const rows = await withRls(tenantId, (tx) => tx`
      select label_norm, concept_key, source_label, confirmed_at
      from client_synonym
      where tenant_id = ${tenantId}
      order by confirmed_at desc
    `);
    return rows.map((r) => ({
      labelNorm: r.label_norm as string,
      conceptKey: r.concept_key as string,
      sourceLabel: r.source_label as string,
      confirmedAt: new Date(r.confirmed_at as string | Date).toISOString(),
    }));
  }

  async recordFeedback(tenantId: string, event: FeedbackEvent): Promise<void> {
    // Pin the tenant defensively so a stored event can never carry another's id.
    const record: FeedbackEvent = { ...event, tenantId };
    await withRls(tenantId, async (tx) => {
      // Tenant must exist before any row that references it.
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
      // Append-only; the seq identity column orders events within the tenant.
      await tx`
        insert into feedback_event (tenant_id, kind, payload, created_at)
        values (${tenantId}, ${record.kind}, ${tx.json(record.payload)}, ${record.createdAt})
      `;
    });
  }

  async listFeedback(tenantId: string, limit = 50): Promise<FeedbackEvent[]> {
    const rows = await withRls(tenantId, (tx) => tx`
      select kind, payload, created_at
      from feedback_event
      where tenant_id = ${tenantId}
      order by created_at desc, seq desc
      limit ${limit}
    `);
    return rows.map((r) => ({
      tenantId,
      kind: r.kind as FeedbackEvent["kind"],
      payload: r.payload as Record<string, unknown>,
      createdAt: new Date(r.created_at as string | Date).toISOString(),
    }));
  }
}
