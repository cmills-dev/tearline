// test/workspace.test.ts
// The tenant workspace loop: generate-then-save on first view, load-from-store on the
// next, and strict tenant isolation. Async because the store interface is async; the
// runner awaits the registrar before running the harness.

import { suite, test, assert, assertEqual } from "./harness";
import { getTearSheet, listWorkspace } from "../lib/workspace";
import { resetStoreForTests } from "../lib/store/tearSheetStore";

export async function registerWorkspaceTests(): Promise<void> {
  resetStoreForTests();

  const first = await getTearSheet("t1", "meridian"); // generates + saves
  const second = await getTearSheet("t1", "meridian"); // reads back from the store
  const t1List = await listWorkspace("t1");
  const t2List = await listWorkspace("t2"); // a different tenant sees nothing
  const unknown = await getTearSheet("t1", "no-such-key");

  suite("workspace / tenant persistence");

  test("first view generates the sheet (not yet in the store)", () => {
    assert(first !== null, "meridian resolves");
    assertEqual(first!.fromStore, false, "first view is generated");
  });

  test("second view reads the same sheet back from the store", () => {
    assert(second !== null, "meridian resolves again");
    assertEqual(second!.fromStore, true, "second view is loaded from the store");
  });

  test("the saved sheet appears in the tenant's workspace list", () => {
    assert(t1List.some((r) => r.key === "meridian"), "meridian is listed for t1");
  });

  test("another tenant's workspace is empty (isolation)", () => {
    assertEqual(t2List.length, 0, "t2 sees nothing t1 saved");
  });

  test("an unknown key resolves to null, never a fabricated sheet", () => {
    assertEqual(unknown, null, "unknown key returns null");
  });
}
