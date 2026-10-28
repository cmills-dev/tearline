// test/monitor.test.ts
// The change-detection engine: the pure differ detects each change kind and emits NOTHING
// when nothing moved; every event carries a provenance (the honesty rule); and the
// watchlist store is strictly tenant-isolated so one desk never sees another's watches,
// snapshots or events. Async because the store interface is async; the runner awaits the
// registrar before running the harness. No network: diff and store are both pure.

import { suite, test, assert, assertEqual } from "./harness";
import { diffSnapshots } from "../lib/monitor/diff";
import type { Snapshot, ChangeEvent } from "../lib/monitor/types";
import { InMemoryMonitorStore } from "../lib/monitor/store";

// A baseline snapshot both tenants and every diff case start from.
function base(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tenantId: "t1",
    chNumber: "00000001",
    takenAt: "2026-08-18T09:00:00.000Z",
    companyStatus: "active",
    charges: [{ id: "1", status: "outstanding" }],
    pscIds: ["Jane Owner (notified 2020-01-01)"],
    officerIds: ["Jane Owner [director] (appointed 2019-01-01)"],
    accountsOverdue: false,
    confirmationOverdue: false,
    ...overrides,
  };
}

function kinds(events: ChangeEvent[]): string[] {
  return events.map((e) => e.kind);
}

export async function registerMonitorTests(): Promise<void> {
  suite("monitor / change detection");

  // --- Nothing changed -> nothing emitted ----------------------------------
  const identical = diffSnapshots(base(), base({ takenAt: "2026-08-18T10:00:00.000Z" }));
  test("emits nothing when nothing changed", () => {
    assertEqual(identical.length, 0, "an unchanged re-check produces no events");
  });

  // --- Each change kind is detected ----------------------------------------
  const chargeRegistered = diffSnapshots(
    base(),
    base({ charges: [{ id: "1", status: "outstanding" }, { id: "2", status: "outstanding" }] }),
  );
  test("detects a newly registered charge", () => {
    assert(kinds(chargeRegistered).includes("charge-registered"), "new charge detected");
  });

  const chargeSatisfied = diffSnapshots(
    base(),
    base({ charges: [{ id: "1", status: "satisfied" }] }),
  );
  test("detects a newly satisfied charge", () => {
    assert(kinds(chargeSatisfied).includes("charge-satisfied"), "satisfied charge detected");
  });

  const pscAdded = diffSnapshots(
    base(),
    base({ pscIds: ["Jane Owner (notified 2020-01-01)", "New Holdings Ltd (notified 2026-08-01)"] }),
  );
  test("detects a new PSC", () => {
    assert(kinds(pscAdded).includes("psc-added"), "new PSC detected");
  });

  const pscRemoved = diffSnapshots(base(), base({ pscIds: [] }));
  test("detects a removed PSC", () => {
    assert(kinds(pscRemoved).includes("psc-removed"), "removed PSC detected");
  });

  const statusChanged = diffSnapshots(base(), base({ companyStatus: "liquidation" }));
  test("detects a company status change", () => {
    assert(kinds(statusChanged).includes("status-changed"), "status change detected");
  });

  const accountsOverdue = diffSnapshots(base(), base({ accountsOverdue: true }));
  test("detects accounts newly overdue", () => {
    assert(kinds(accountsOverdue).includes("accounts-overdue"), "accounts overdue detected");
  });

  const confirmationOverdue = diffSnapshots(base(), base({ confirmationOverdue: true }));
  test("detects confirmation statement newly overdue", () => {
    assert(kinds(confirmationOverdue).includes("confirmation-overdue"), "confirmation overdue detected");
  });

  const officerAppointed = diffSnapshots(
    base(),
    base({ officerIds: ["Jane Owner [director] (appointed 2019-01-01)", "New Director [director] (appointed 2026-08-01)"] }),
  );
  test("detects a new officer appointment", () => {
    assert(kinds(officerAppointed).includes("officer-appointed"), "new officer detected");
  });

  // --- The negative edges: an already-satisfied charge is not re-emitted ----
  const alreadySatisfied = diffSnapshots(
    base({ charges: [{ id: "1", status: "satisfied" }] }),
    base({ charges: [{ id: "1", status: "satisfied" }] }),
  );
  test("does not re-emit a charge that was already satisfied", () => {
    assertEqual(alreadySatisfied.length, 0, "no event when status is unchanged");
  });

  // --- A non-satisfied status movement is a real change (was previously dropped) ---
  const partSatisfied = diffSnapshots(
    base({ charges: [{ id: "1", status: "outstanding" }] }),
    base({ charges: [{ id: "1", status: "part-satisfied" }] }),
  );
  test("detects an outstanding -> part-satisfied charge movement", () => {
    assert(kinds(partSatisfied).includes("charge-status-changed"), "status change surfaced, not dropped");
    assert(partSatisfied[0].detail.includes("part-satisfied"), "detail names the new status");
  });

  // --- A charge that disappears from the register is a real movement (was dropped) ---
  const chargeRemoved = diffSnapshots(
    base({ charges: [{ id: "1", status: "outstanding" }] }),
    base({ charges: [] }),
  );
  test("detects a charge removed from the register", () => {
    assert(kinds(chargeRemoved).includes("charge-removed"), "removed charge surfaced");
  });

  // --- A charge status going blank (a fetch/data gap) must NOT render as a movement ---
  const statusWentBlank = diffSnapshots(
    base({ charges: [{ id: "1", status: "outstanding" }] }),
    base({ charges: [{ id: "1", status: "" }] }),
  );
  test("does not emit a charge movement when a status merely went blank", () => {
    assertEqual(statusWentBlank.length, 0, "an empty status is a data gap, not a cited change");
  });

  // --- Every event carries provenance (the honesty rule) --------------------
  const allEvents = [
    ...chargeRegistered,
    ...chargeSatisfied,
    ...pscAdded,
    ...pscRemoved,
    ...statusChanged,
    ...accountsOverdue,
    ...confirmationOverdue,
    ...officerAppointed,
  ];
  test("every emitted event carries a source-bearing provenance", () => {
    assert(allEvents.length > 0, "there are events to check");
    for (const e of allEvents) {
      assert(!!e.provenance, `event ${e.kind} has provenance`);
      assert(!!e.provenance.source, `event ${e.kind} names a source`);
      assert(!!e.provenance.field, `event ${e.kind} names the field that moved`);
      assert(!!e.provenance.retrievedAt, `event ${e.kind} records when it was read`);
      assert(!!e.provenance.locator, `event ${e.kind} carries a public locator`);
    }
  });

  test("provenance retrievedAt and observedAt derive from the fresh snapshot", () => {
    for (const e of chargeRegistered) {
      assertEqual(e.observedAt, "2026-08-18T09:00:00.000Z", "observedAt is the next snapshot time");
      assertEqual(e.provenance.retrievedAt, "2026-08-18T09:00:00.000Z", "retrievedAt matches");
    }
  });

  // --- Store tenant isolation ----------------------------------------------
  const store = new InMemoryMonitorStore();
  await store.addToWatchlist("t1", "00000001");
  await store.addToWatchlist("t2", "00000002");
  await store.saveSnapshot(base({ tenantId: "t1", chNumber: "00000001" }));
  await store.recordEvents(statusChanged); // these belong to t1 (tenantId on the event)

  const t1Watch = await store.listWatchlist("t1");
  const t2Watch = await store.listWatchlist("t2");
  const t1Events = await store.listEvents("t1");
  const t2Events = await store.listEvents("t2");
  const t2Snap = await store.loadSnapshot("t2", "00000001");

  test("a tenant's watchlist holds only its own companies", () => {
    assertEqual(t1Watch.length, 1, "t1 watches one company");
    assertEqual(t1Watch[0].chNumber, "00000001", "t1 watches its own number");
    assert(!t2Watch.some((w) => w.chNumber === "00000001"), "t2 cannot see t1's watch");
  });

  test("a tenant sees only its own change events", () => {
    assert(t1Events.length > 0, "t1 has recorded events");
    assertEqual(t2Events.length, 0, "t2 sees none of t1's events");
  });

  test("a snapshot is not visible to another tenant", () => {
    assertEqual(t2Snap, null, "t2 cannot load t1's snapshot");
  });

  test("only tenants with watches are enumerated for the cron sweep", async () => {
    const tenants = await store.listTenantsWithWatches();
    assert(tenants.includes("t1") && tenants.includes("t2"), "both watching tenants listed");
  });
}
