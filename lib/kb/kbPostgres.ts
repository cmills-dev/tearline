// lib/kb/kbPostgres.ts
// The DURABLE KbStore for the Module-2 knowledge-graph plane. Like lib/clientspec/sharedPostgres.ts
// (and UNLIKE the tenant-scoped lib/store/postgres.ts), this store is GLOBAL: there is NO withRls /
// app.tenant_id here, because master_entity / kb_document / kb_fact (db/migrations/0009_kb.sql) are
// the shared Tier-0 plane holding PUBLIC facts (Companies House, EDGAR, ESEF) shared across
// tenants, deliberately outside the row-level-security wall. Entitled/client facts carry an
// `entitlement` tag for a later per-tenant silo; the tag is persisted here now so the export-policy
// layer has something to read, but this store adds no tenant scoping of its own.
//
// The `postgres` client is a GUARDED DYNAMIC IMPORT (mirror lib/store/postgres.ts) so the build
// passes without it installed; it activates only when DATABASE_URL is set (see getKbStore).
// Queries are plain (no transaction GUC) since there is no tenant to pin.

import type {
  EntityIdentifiers,
  KbCoverage,
  KbCoverageItem,
  KbDocumentRecord,
  KbFactRecord,
  KbInstrument,
  KbStore,
  MasterEntity,
} from "./kbTypes";
import { assertPublicTier0 } from "./kbTypes";
import {
  chooseMasterId,
  identifiersMatch,
  mergeIdentifiers,
  normCh,
  normCik,
  normLei,
  strongerId,
} from "./masterId";
import { databaseUrl } from "../store/postgres";

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
  if (!url) throw new Error("PostgresKbStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

function ms(asOf: string | null | undefined): number {
  if (!asOf) return 0;
  const t = new Date(asOf).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

// Reconstruct the EntityIdentifiers a source would present from a stored row. Empty join keys are
// dropped so identifiersMatch behaves identically to the in-memory path.
function rowIdentifiers(r: Record<string, unknown>): EntityIdentifiers {
  const ids: EntityIdentifiers = { name: (r.primary_name as string) ?? "" };
  if (r.lei) ids.lei = r.lei as string;
  if (r.ch_number) ids.chNumber = r.ch_number as string;
  if (r.cik) ids.cik = r.cik as string;
  return ids;
}

function rowEntity(r: Record<string, unknown>): MasterEntity {
  return {
    masterId: r.master_id as string,
    identifiers: rowIdentifiers(r),
    names: (r.names as string[]) ?? [],
    sources: (r.sources as string[]) ?? [],
    firstSeen: iso(r.first_seen),
    lastSeen: iso(r.last_seen),
  };
}

function rowInstrument(r: Record<string, unknown>): KbInstrument {
  return {
    masterId: r.master_id as string,
    instrumentId: r.instrument_id as string,
    kind: r.kind as KbInstrument["kind"],
    label: (r.label as string) ?? "",
    metric: (r.metric as string) ?? "",
    source: r.source as string,
    asOf: r.as_of ? iso(r.as_of) : "",
    entitlement: r.entitlement as KbInstrument["entitlement"],
  };
}

function rowFact(r: Record<string, unknown>): KbFactRecord {
  return {
    masterId: r.master_id as string,
    metric: r.metric as string,
    period: r.period as string,
    value: r.value as KbFactRecord["value"],
    kind: r.kind as KbFactRecord["kind"],
    unit: (r.unit as string) ?? "",
    rung: r.rung as KbFactRecord["rung"],
    source: r.source as string,
    docId: (r.doc_id as string) ?? "",
    asOf: r.as_of ? iso(r.as_of) : "",
    entitlement: r.entitlement as KbFactRecord["entitlement"],
    provenance: r.provenance as KbFactRecord["provenance"],
    superseded: r.superseded === true,
    ingestedAt: iso(r.ingested_at),
  };
}

// The join-key columns written for an entity: normalised so matching is reliable across sources.
function joinCols(ids: EntityIdentifiers): { lei: string | null; ch: string | null; cik: string | null } {
  const lei = normLei(ids.lei);
  const ch = normCh(ids.chNumber);
  const cik = normCik(ids.cik);
  return { lei: lei || null, ch: ch || null, cik: cik || null };
}

export class PostgresKbStore implements KbStore {
  async resolveEntity(ids: EntityIdentifiers): Promise<string> {
    const sql = await getSql();
    return sql.begin(async (tx) => {
      const lei = normLei(ids.lei);
      const ch = normCh(ids.chNumber);
      const cik = normCik(ids.cik);

      // Candidate rows: any entity sharing a non-empty join key. identifiersMatch then filters in
      // JS so the exact same matching rule (never on name alone) governs both store backends.
      const rows = await tx`
        select master_id, ch_number, cik, lei, primary_name, names, sources, first_seen, last_seen
        from master_entity
        where (${lei !== ""} and lei = ${lei})
           or (${ch !== ""} and ch_number = ${ch})
           or (${cik !== ""} and cik = ${cik})
        order by master_id
      `;
      const matches = rows.map(rowEntity).filter((e) => identifiersMatch(e.identifiers, ids));

      // (1) Nothing matched: mint a new master entity.
      if (matches.length === 0) {
        const masterId = chooseMasterId(ids);
        const cols = joinCols(ids);
        await tx`
          insert into master_entity
            (master_id, ch_number, cik, lei, primary_name, names, sources, first_seen, last_seen)
          values
            (${masterId}, ${cols.ch}, ${cols.cik}, ${cols.lei}, ${ids.name},
             ${tx.json([ids.name])}, ${tx.json([])}, now(), now())
        `;
        return masterId;
      }

      // (2) Exactly one matched: fold the new ids/name in and refresh lastSeen.
      if (matches.length === 1) {
        const survivor = matches[0];
        await this.applyMerged(tx, survivor, ids);
        return survivor.masterId;
      }

      // (3) Several matched: the ids bridge separate entities. Collapse into the strongest survivor.
      let survivor = matches[0];
      for (let i = 1; i < matches.length; i++) {
        if (strongerId(matches[i].masterId, survivor.masterId) === matches[i].masterId) {
          survivor = matches[i];
        }
      }
      for (const loser of matches) {
        if (loser.masterId === survivor.masterId) continue;
        // Union metadata into the survivor in memory, then re-point the loser's rows and drop it.
        survivor.identifiers = mergeIdentifiers(survivor.identifiers, loser.identifiers);
        for (const n of loser.names) if (!survivor.names.includes(n)) survivor.names.push(n);
        for (const s of loser.sources) if (!survivor.sources.includes(s)) survivor.sources.push(s);
        if (ms(loser.firstSeen) < ms(survivor.firstSeen)) survivor.firstSeen = loser.firstSeen;
        if (ms(loser.lastSeen) > ms(survivor.lastSeen)) survivor.lastSeen = loser.lastSeen;
        // kb_document and kb_instrument carry NATURAL composite keys, so a blind re-point collides
        // when the survivor already holds the same row. Drop the loser's colliding rows first (a
        // re-fetch of the same document, or the same instrument from the same source, is identical),
        // then re-point the rest. kb_fact has a surrogate id, so it re-points without collision.
        await tx`delete from kb_document d where d.master_id = ${loser.masterId}
                   and exists (select 1 from kb_document s where s.master_id = ${survivor.masterId} and s.doc_id = d.doc_id)`;
        await tx`update kb_document set master_id = ${survivor.masterId} where master_id = ${loser.masterId}`;
        await tx`update kb_fact set master_id = ${survivor.masterId} where master_id = ${loser.masterId}`;
        // Reconcile the survivor's fact lanes after the re-point. BOTH entities may have held a live
        // fact for the SAME (metric, period, source), which would leave two live facts in one lane
        // and break the one-live-per-lane invariant. Per (master_id, metric, period, source), keep
        // the newest-asOf live row live and mark the rest superseded (ties keep the lowest id, i.e.
        // the earlier-ingested, live). We never delete a fact; lineage is kept.
        await tx`
          update kb_fact set superseded = true
          where id in (
            select id from (
              select id, row_number() over (
                partition by metric, period, source
                order by as_of desc nulls last, id asc
              ) as rn
              from kb_fact
              where master_id = ${survivor.masterId} and superseded = false
            ) ranked
            where ranked.rn > 1
          )
        `;
        await tx`delete from kb_instrument i where i.master_id = ${loser.masterId}
                   and exists (select 1 from kb_instrument s where s.master_id = ${survivor.masterId}
                               and s.instrument_id = i.instrument_id and s.source = i.source)`;
        await tx`update kb_instrument set master_id = ${survivor.masterId} where master_id = ${loser.masterId}`;
        await tx`delete from master_entity where master_id = ${loser.masterId}`;
      }
      await this.applyMerged(tx, survivor, ids);
      return survivor.masterId;
    });
  }

  // Persist the survivor after folding `ids` (and any absorbed metadata already on `survivor`) in.
  private async applyMerged(tx: Sql, survivor: MasterEntity, ids: EntityIdentifiers): Promise<void> {
    const identifiers = mergeIdentifiers(survivor.identifiers, ids);
    const names = [...survivor.names];
    if (ids.name && !names.includes(ids.name)) names.push(ids.name);
    const cols = joinCols(identifiers);
    await tx`
      update master_entity set
        ch_number = ${cols.ch},
        cik = ${cols.cik},
        lei = ${cols.lei},
        primary_name = ${identifiers.name},
        names = ${tx.json(names)},
        sources = ${tx.json(survivor.sources)},
        first_seen = ${survivor.firstSeen},
        last_seen = now()
      where master_id = ${survivor.masterId}
    `;
  }

  async getEntity(masterId: string): Promise<MasterEntity | null> {
    const sql = await getSql();
    const rows = await sql`
      select master_id, ch_number, cik, lei, primary_name, names, sources, first_seen, last_seen
      from master_entity where master_id = ${masterId}
    `;
    return rows.length ? rowEntity(rows[0]) : null;
  }

  async listEntities(): Promise<MasterEntity[]> {
    const sql = await getSql();
    const rows = await sql`
      select master_id, ch_number, cik, lei, primary_name, names, sources, first_seen, last_seen
      from master_entity order by first_seen asc
    `;
    return rows.map(rowEntity);
  }

  async addDocument(doc: KbDocumentRecord): Promise<void> {
    assertPublicTier0(doc.entitlement, "document");
    const sql = await getSql();
    await sql.begin(async (tx) => {
      // Upsert the document by (master_id, doc_id).
      await tx`
        insert into kb_document
          (master_id, doc_id, source, document_name, retrieved_at, as_of, content_hash, entitlement)
        values
          (${doc.masterId}, ${doc.docId}, ${doc.source}, ${doc.documentName},
           ${doc.retrievedAt}, ${doc.asOf ?? null}, ${doc.contentHash ?? null}, ${doc.entitlement})
        on conflict (master_id, doc_id) do update set
          source = excluded.source,
          document_name = excluded.document_name,
          retrieved_at = excluded.retrieved_at,
          as_of = excluded.as_of,
          content_hash = excluded.content_hash,
          entitlement = excluded.entitlement
      `;
      // Add the contributing source to the entity's source list (jsonb union), refresh lastSeen.
      const rows = await tx`select sources from master_entity where master_id = ${doc.masterId}`;
      if (rows.length) {
        const sources = (rows[0].sources as string[]) ?? [];
        if (!sources.includes(doc.source)) sources.push(doc.source);
        await tx`
          update master_entity set sources = ${tx.json(sources)}, last_seen = now()
          where master_id = ${doc.masterId}
        `;
      }
    });
  }

  async upsertFact(fact: KbFactRecord): Promise<void> {
    assertPublicTier0(fact.entitlement, "fact");
    const sql = await getSql();
    await sql.begin(async (tx) => {
      // The current LIVE fact for THIS SOURCE's (master_id, metric, period) lane, if any. Precedence
      // is within a source's own restatements; distinct sources corroborate and each stay live.
      const liveRows = await tx`
        select id, as_of from kb_fact
        where master_id = ${fact.masterId} and metric = ${fact.metric}
          and period = ${fact.period} and source = ${fact.source} and superseded = false
        order by id asc
        for update
      `;
      const live = liveRows[0];

      // AMENDMENT PRECEDENCE: new fact is live only when the lane is empty or its asOf is strictly
      // newer; otherwise it is retained as superseded for lineage. A fact is never deleted.
      let superseded = false;
      if (live) {
        if (ms(fact.asOf) > ms(iso(live.as_of))) {
          await tx`update kb_fact set superseded = true where id = ${live.id}`;
          superseded = false;
        } else {
          superseded = true;
        }
      }

      await tx`
        insert into kb_fact
          (master_id, metric, period, value, kind, unit, rung, source, doc_id, as_of,
           entitlement, provenance, superseded)
        values
          (${fact.masterId}, ${fact.metric}, ${fact.period}, ${tx.json(fact.value)}, ${fact.kind},
           ${fact.unit}, ${fact.rung}, ${fact.source}, ${fact.docId}, ${fact.asOf ?? null},
           ${fact.entitlement}, ${tx.json(fact.provenance ?? null)}, ${superseded})
      `;
    });
  }

  async listFacts(masterId: string, opts?: { includeSuperseded?: boolean }): Promise<KbFactRecord[]> {
    const sql = await getSql();
    const rows = opts?.includeSuperseded === true
      ? await sql`select * from kb_fact where master_id = ${masterId} order by id asc`
      : await sql`select * from kb_fact where master_id = ${masterId} and superseded = false order by id asc`;
    return rows.map(rowFact);
  }

  async coverage(masterId: string): Promise<KbCoverage> {
    const sql = await getSql();
    const entityRows = await sql`select names from master_entity where master_id = ${masterId}`;
    const entityName = entityRows.length ? ((entityRows[0].names as string[])?.[0] ?? "") : "";

    const rows = await sql`
      select metric, period, rung, source, as_of from kb_fact
      where master_id = ${masterId} and superseded = false
      order by id asc
    `;

    // One coverage item per live (metric, period): its sources, the freshest asOf and that
    // record's rung. Built in JS to mirror the in-memory store exactly.
    const byLane = new Map<string, KbCoverageItem>();
    const order: string[] = [];
    const distinctSources = new Set<string>();
    for (const r of rows) {
      const metric = r.metric as string;
      const period = r.period as string;
      const source = r.source as string;
      const asOf = r.as_of ? iso(r.as_of) : "";
      distinctSources.add(source);
      const key = `${metric} ${period}`;
      let item = byLane.get(key);
      if (!item) {
        item = { metric, period, rung: r.rung as KbCoverageItem["rung"], sources: [], asOf };
        byLane.set(key, item);
        order.push(key);
      }
      if (!item.sources.includes(source)) item.sources.push(source);
      if (ms(asOf) > ms(item.asOf)) {
        item.asOf = asOf;
        item.rung = r.rung as KbCoverageItem["rung"];
      }
    }

    return {
      masterId,
      entityName,
      items: order.map((k) => byLane.get(k)!),
      sourceCount: distinctSources.size,
    };
  }

  async upsertInstrument(instrument: KbInstrument): Promise<void> {
    assertPublicTier0(instrument.entitlement, "instrument");
    const sql = await getSql();
    // Upsert by (master_id, instrument_id, source): a re-ingest from the same source overwrites in
    // place; the same instrument from a DIFFERENT source is a separate row (corroboration).
    await sql`
      insert into kb_instrument
        (master_id, instrument_id, kind, label, metric, source, as_of, entitlement)
      values
        (${instrument.masterId}, ${instrument.instrumentId}, ${instrument.kind}, ${instrument.label},
         ${instrument.metric}, ${instrument.source}, ${instrument.asOf ?? null}, ${instrument.entitlement})
      on conflict (master_id, instrument_id, source) do update set
        kind = excluded.kind,
        label = excluded.label,
        metric = excluded.metric,
        as_of = excluded.as_of,
        entitlement = excluded.entitlement
    `;
  }

  async listInstruments(masterId: string): Promise<KbInstrument[]> {
    const sql = await getSql();
    const rows = await sql`select * from kb_instrument where master_id = ${masterId} order by instrument_id asc`;
    return rows.map(rowInstrument);
  }
}
