// lib/config/launchRoutes.ts
// The single source for which routes are public, which are launch routes and which are hidden at
// launch (WP-FE01: DSD-20, FE-07 part, FE-09). Pure and env-reading only, with no Next or node
// import, so the edge middleware, the page guards and the tests all read the same list.
//
// Three rules live here:
//   1. Public paths: reachable signed out even with AUTH_REQUIRED=1 (login, the auth routes,
//      health, cron, and the static files a browser or crawler fetches before signing in).
//   2. Hidden routes: /onboarding/assistant and the ten non-launch surfaces answer 404 in
//      production. SHOW_NON_LAUNCH_ROUTES=1 brings them back (a dev or preview demo); =0 hides
//      them outside production too, so the hiding can be checked locally.
//   3. The return path after sign-in: only a same-origin path is ever followed.
//
// The hidden list follows docs/programme/audit/app-frontend.md FE-09. It waits on Cam's
// confirmation; see docs/programme/reports/WP-FE01.md. Changing a route's status is a one-line
// edit here, and nowhere else.

import { isProd } from "./prodGuard";

// The launch surfaces: login, run entry, run progress (/run, and /live until WP-FE03 turns it into a redirect), the
// sheet and the workspace. The not-found page has no path of its own. Listed for the record and
// for the tests; everything not hidden stays reachable, so this list gates nothing by itself.
export const LAUNCH_ROUTES: readonly string[] = ["/login", "/", "/live", "/run", "/sheet", "/workspace"];

// Removed from the launch build outright (FE-09): the conversational onboarding variant.
export const REMOVED_ROUTES: readonly string[] = ["/onboarding/assistant"];

// The ten non-launch routes (FE-09). Each prefix also covers its sub-paths.
export const NON_LAUNCH_ROUTES: readonly string[] = [
  "/sec",
  "/onboarding",
  "/housesheet",
  "/originate",
  "/pipeline",
  "/watchlist",
  "/screen",
  "/review",
  "/kb",
  "/shared-learning",
];

export const HIDDEN_ROUTES: readonly string[] = [...REMOVED_ROUTES, ...NON_LAUNCH_ROUTES];

// Reachable without a session, whatever AUTH_REQUIRED says. Prefixes cover their sub-paths.
const PUBLIC_PREFIXES: readonly string[] = ["/login", "/api/auth", "/api/health", "/api/cron"];

// Files fetched without a session: framework assets, the favicon and the metadata images Next
// serves from app/ (icon, apple-icon, opengraph-image). Matched by exact name or name prefix, never
// by a bare file extension, so `/sheet/x.pdf` cannot slip past the gate.
const PUBLIC_FILES = /^\/(?:_next\/|favicon\.ico$|robots\.txt$|sitemap\.xml$|(?:icon|apple-icon|opengraph-image|twitter-image)(?:[\w.-]*)$)/;

// API calls that need a signed-in session even in the anonymous demo mode (AUTH_REQUIRED unset):
// the kb ingest writes to the shared Tier-0 plane, which no anonymous browser may write to.
const SESSION_ONLY_PREFIXES: readonly string[] = ["/api/kb/ingest"];

function underPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// A trailing slash or a doubled slash must not dodge a prefix match.
export function normalisePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

export function isPublicPath(pathname: string): boolean {
  const p = normalisePath(pathname);
  return PUBLIC_FILES.test(p) || PUBLIC_PREFIXES.some((prefix) => underPrefix(p, prefix));
}

export function needsSessionAlways(pathname: string): boolean {
  const p = normalisePath(pathname);
  return SESSION_ONLY_PREFIXES.some((prefix) => underPrefix(p, prefix));
}

export function isApiPath(pathname: string): boolean {
  return underPrefix(normalisePath(pathname), "/api");
}

// Whether the non-launch routes are hidden in this environment. SHOW_NON_LAUNCH_ROUTES wins when
// set; otherwise they are hidden in production (isProd reads NODE_ENV and VERCEL_ENV) and shown
// in dev.
export function nonLaunchRoutesHidden(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SHOW_NON_LAUNCH_ROUTES === "1") return false;
  if (env.SHOW_NON_LAUNCH_ROUTES === "0") return true;
  return isProd(env);
}

// True when this path belongs to a hidden route and hiding is on.
export function isHiddenRoute(pathname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!nonLaunchRoutesHidden(env)) return false;
  const p = normalisePath(pathname);
  return HIDDEN_ROUTES.some((prefix) => underPrefix(p, prefix));
}

// The path to return to after sign-in, or "/" when the value is missing or unsafe. Only a
// same-origin absolute path is kept: no scheme, no protocol-relative `//host`, no backslash trick,
// and never /login itself (which would loop).
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f]/.test(value)) return "/";
  let parsed: URL;
  try {
    parsed = new URL(value, "http://same.origin");
  } catch {
    return "/";
  }
  if (parsed.origin !== "http://same.origin") return "/";
  if (underPrefix(normalisePath(parsed.pathname), "/login")) return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
