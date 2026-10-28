// lib/engine/hash.ts
// A small, dependency-free, deterministic content hash (FNV-1a, 64-bit) rendered as
// hex. Content hashes are computed once at ingest / assemble time and then READ at
// view time. The viewer never recomputes evidence; it displays the stored hash.
//
// Why this is not createHash("sha256") from node:crypto (RS-06 finding 7, checked 24 Sep 2026 and
// left as it is on purpose):
//   - It runs in the browser. app/components/ScreenView.tsx is a client component and builds
//     manifests through lib/engineB/universe.ts -> lib/engine/buildManifest.ts, and SheetView
//     imports lib/engine/assemble.ts; both import this file. node:crypto does not exist there, and
//     Web Crypto's digest is async only, which every caller of this synchronous function would
//     have to become. A hand-written SHA-256 would be the reinvention RS-06 exists to remove.
//   - Its output is stored. Every hash is in tear_sheet.manifest (jsonb), in the CSV and workbook
//     exports people download, and inside the evidence-card hashes chained over it (assemble.ts).
//     A different output would leave every stored hash unreproducible by this code.
// If it is ever changed, keep this function under another name so old records still verify, and
// give the new one its own prefix. test/hash.test.ts pins the current values so a change cannot
// be made by accident.

export function contentHash(input: string): string {
  // 64-bit FNV-1a implemented with BigInt for determinism across environments.
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & MASK;
  }
  // Prefix names the ACTUAL algorithm. It is FNV-1a, not a SHA family hash, so it must not carry a
  // "sha-" label - that would misrepresent the evidence hash as cryptographic when it is not.
  return "fnv1a:" + hash.toString(16).padStart(16, "0");
}
