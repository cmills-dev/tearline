// scripts/add-user.ts (WP-DS05, DSD-12)
// Invite a user to a named tenant. Run from product/:
//
//   npx tsx scripts/add-user.ts --tenant demo --email analyst@firm.com --send
//   npx tsx scripts/add-user.ts --tenant demo --email analyst@firm.com --dry-run
//
// It writes an invite (token hashed at rest, seven days) and prints the link. --send prints the
// invite email too. Nothing is sent: no mail provider is wired yet. The person registers from
// the link and joins that tenant. The logic lives in lib/auth/invite.ts, where the tests drive it.
//
// The store is Postgres when DATABASE_URL (or POSTGRES_URL) is set. Without it the invite
// lives only in this process and the link cannot work, so the script says so.

import { databaseUrl } from "../lib/store/postgres";
import { getAuthStore } from "../lib/auth/store";
import { runAddUser } from "../lib/auth/invite";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (!databaseUrl() && !argv.includes("--help") && !argv.includes("-h")) {
    console.log("Note: no DATABASE_URL. This uses the in-memory store, so the invite dies with this process.");
  }
  return runAddUser(argv, getAuthStore(), (line) => console.log(line));
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`add-user: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
