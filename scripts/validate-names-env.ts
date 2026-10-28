// scripts/validate-names-env.ts
// Loads product/.env.local into process.env for scripts/validate-names.ts. It is its own module
// because imports run in order: imported first, it runs before any lib module reads the env.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const p = join(resolve(__dirname, ".."), ".env.local");
if (existsSync(p)) {
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
