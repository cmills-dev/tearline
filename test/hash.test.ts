// test/hash.test.ts
// contentHash's output is stored: in tear_sheet.manifest, in downloaded exports, and inside the
// evidence-card hashes chained over it. These values pin it, so a change to the algorithm, the
// byte encoding or the prefix fails here rather than silently leaving every stored hash
// unreproducible (RS-06 finding 7; see the note in lib/engine/hash.ts).

import { contentHash } from "../lib/engine/hash";
import { suite, test, assertEqual } from "./harness";

suite("hash / contentHash output is pinned");

test("the published 64-bit FNV-1a vectors", () => {
  assertEqual(contentHash(""), "fnv1a:cbf29ce484222325", "empty input is the offset basis");
  assertEqual(contentHash("a"), "fnv1a:af63dc4c8601ec8c", "a");
  assertEqual(contentHash("foobar"), "fnv1a:85944171f73967e8", "foobar");
});

test("an ingest-shaped input and a non-ASCII one hash as they did on 24 Sep 2026", () => {
  assertEqual(contentHash("companies-house|12092575|NET LIABILITIES (144)"), "fnv1a:08d6aa256cda09c8", "a register snippet");
  assertEqual(contentHash("Ørsted £1,008.0m"), "fnv1a:b3307593d2534e29", "UTF-8 bytes, not UTF-16 code units");
});
