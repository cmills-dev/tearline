// lib/release/smoke.ts (WP-QA08, TQ-15)
// The production smoke check, as a library so the unit tests can drive it with a mocked fetch.
// The command line lives in scripts/smoke-prod.ts.
//
// What it proves against a deployed app and site, in order:
//   TLS on both hosts, security headers on both landings, /api/health (ready, storeDurable,
//   dataMode live, cacheBackend upstash, a real commit), a sign-in as the demo user, one run on
//   the demo tenant polled to done, the signed-out wall on that run, one .xlsx export of its
//   sheet, the site landing, and the demo form (a refusal of an empty submission, so nothing is
//   ever sent).
//
// Secrets. The demo password and the Vercel bypass token are read from the environment only,
// never from an argument, and never printed. Session cookies are held in memory and never
// printed. Nothing about the deploy target is hardcoded: every URL comes from the caller.
//
// Verdict. Any FAIL fails the smoke (exit 1). A skipped check with no failure is INCOMPLETE
// (exit 3), so a smoke with parts switched off can never read as a pass. WARN does not fail.

import { connect as tlsConnect } from "node:tls";

export type Verdict = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  id: string;
  verdict: Verdict;
  detail: string;
}

export interface SmokeConfig {
  appUrl: string; // origin (and optional base path) of the product app, no trailing slash
  siteUrl: string; // origin of the marketing site
  email: string | null; // demo user, from SMOKE_EMAIL
  password: string | null; // demo password, from SMOKE_PASSWORD. Never printed.
  runInput: string | null; // a Companies House number is safest, from SMOKE_RUN_INPUT
  expectCommit: string | null; // the tagged commit the deploy should report
  bypassToken: string | null; // Vercel protection bypass for a protected preview. Never printed.
  brandText: string; // text the site landing must carry
  runTimeoutMs: number;
  pollMs: number;
  allowPartial: boolean; // a partial run is a warn rather than a fail
  skip: Set<string>; // check groups switched off: tls, headers, health, login, run, export, site, demo
}

export interface TlsInfo {
  authorized: boolean;
  authorizationError: string | null;
  protocol: string | null;
  validTo: string | null; // as the certificate prints it
}

export interface SmokeDeps {
  fetch: typeof fetch;
  tlsProbe: (url: string) => Promise<TlsInfo>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface SmokeReport {
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  exitCode: 0 | 1 | 3;
  results: CheckResult[];
  startedAt: string;
  elapsedMs: number;
  target: { app: string; site: string };
}

export const CHECK_GROUPS = ["tls", "headers", "health", "login", "run", "export", "site", "demo"] as const;

export const DEFAULTS = {
  brandText: "Tearline",
  runTimeoutMs: 150_000, // the run's own budget is 120 s, plus polling slack
  pollMs: 2_000,
  certMinDays: 14, // fail under this
  certWarnDays: 30, // warn under this
  hstsMinSeconds: 15_552_000, // 180 days
};

// --------------------------------------------------------------------------------------------
// Arguments. Kept here so the tests can prove the refusals (no password flag, no plain http to a
// real host, no credentials inside a URL).

export interface ParsedArgs {
  mode: "run" | "dry-run" | "self-test" | "help";
  json: boolean;
  out: string | null;
  config: SmokeConfig | null;
  errors: string[];
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function normaliseBase(raw: string, label: string, errors: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`${label} is not a URL: ${JSON.stringify(raw)}`);
    return null;
  }
  if (u.username || u.password) {
    errors.push(`${label} carries credentials inside the URL. Put secrets in the environment instead.`);
    return null;
  }
  if (u.search || u.hash) {
    errors.push(`${label} must be a base URL with no query or fragment.`);
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) {
    errors.push(`${label} must be https (plain http is allowed for localhost only).`);
    return null;
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): ParsedArgs {
  const errors: string[] = [];
  let mode: ParsedArgs["mode"] = "run";
  let json = false;
  let out: string | null = null;
  let app = env.SMOKE_APP_URL ?? "";
  let site = env.SMOKE_SITE_URL ?? "";
  let runInput = env.SMOKE_RUN_INPUT ?? "";
  let expectCommit = env.SMOKE_EXPECT_COMMIT ?? "";
  let brandText = env.SMOKE_BRAND_TEXT ?? DEFAULTS.brandText;
  let runTimeoutMs = DEFAULTS.runTimeoutMs;
  let allowPartial = false;
  const skip = new Set<string>();

  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      errors.push(`${flag} needs a value.`);
      return "";
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        mode = "help";
        break;
      case "--dry-run":
        mode = "dry-run";
        break;
      case "--self-test":
        mode = "self-test";
        break;
      case "--json":
        json = true;
        break;
      case "--allow-partial":
        allowPartial = true;
        break;
      case "--app":
        app = valueOf(i, a);
        i++;
        break;
      case "--site":
        site = valueOf(i, a);
        i++;
        break;
      case "--run-input":
        runInput = valueOf(i, a);
        i++;
        break;
      case "--expect-commit":
        expectCommit = valueOf(i, a);
        i++;
        break;
      case "--brand-text":
        brandText = valueOf(i, a);
        i++;
        break;
      case "--out":
        out = valueOf(i, a) || null;
        i++;
        break;
      case "--run-timeout": {
        const s = Number(valueOf(i, a));
        i++;
        if (!Number.isFinite(s) || s <= 0) errors.push("--run-timeout takes a number of seconds.");
        else runTimeoutMs = s * 1000;
        break;
      }
      case "--skip": {
        const v = valueOf(i, a);
        i++;
        for (const g of v.split(",").map((x) => x.trim()).filter(Boolean)) {
          if ((CHECK_GROUPS as readonly string[]).includes(g)) skip.add(g);
          else errors.push(`--skip: unknown check group "${g}". Known: ${CHECK_GROUPS.join(", ")}.`);
        }
        break;
      }
      case "--password":
      case "--email":
      case "--bypass-token":
        errors.push(`${a} is refused. Set it in the environment (SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_BYPASS_TOKEN) so it stays out of shell history.`);
        i++;
        break;
      default:
        errors.push(`Unknown argument: ${a}`);
    }
  }

  if (mode === "help" || mode === "self-test") return { mode, json, out, config: null, errors };

  if (!app) errors.push("No app URL. Pass --app <url> or set SMOKE_APP_URL.");
  if (!site) errors.push("No site URL. Pass --site <url> or set SMOKE_SITE_URL.");
  const appUrl = app ? normaliseBase(app, "The app URL", errors) : null;
  const siteUrl = site ? normaliseBase(site, "The site URL", errors) : null;

  const config: SmokeConfig | null =
    appUrl && siteUrl
      ? {
          appUrl,
          siteUrl,
          email: env.SMOKE_EMAIL?.trim() || null,
          password: env.SMOKE_PASSWORD || null,
          runInput: runInput.trim() || null,
          expectCommit: expectCommit.trim() || null,
          bypassToken: env.SMOKE_BYPASS_TOKEN || env.VERCEL_AUTOMATION_BYPASS_SECRET || null,
          brandText,
          runTimeoutMs,
          pollMs: DEFAULTS.pollMs,
          allowPartial,
          skip,
        }
      : null;
  return { mode, json, out, config, errors };
}

// --------------------------------------------------------------------------------------------
// The real TLS probe. A handshake only: no request is sent.

export function realTlsProbe(url: string, timeoutMs = 10_000): Promise<TlsInfo> {
  const u = new URL(url);
  if (u.protocol !== "https:") {
    return Promise.resolve({ authorized: false, authorizationError: "not https", protocol: null, validTo: null });
  }
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: u.hostname,
      port: Number(u.port || 443),
      servername: u.hostname,
      rejectUnauthorized: false, // read the verdict ourselves so it can be reported
    });
    const done = (info: TlsInfo) => {
      socket.destroy();
      resolve(info);
    };
    socket.setTimeout(timeoutMs, () =>
      done({ authorized: false, authorizationError: "TLS handshake timed out", protocol: null, validTo: null }),
    );
    socket.once("error", (e) => done({ authorized: false, authorizationError: e.message, protocol: null, validTo: null }));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      done({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        protocol: socket.getProtocol(),
        validTo: cert?.valid_to ?? null,
      });
    });
  });
}

export function realDeps(): SmokeDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    tlsProbe: (url) => realTlsProbe(url),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// --------------------------------------------------------------------------------------------
// The checks.

interface Session {
  cookie: string; // "name=value; name2=value2", held in memory only
}

function cookieHeader(res: Response): string {
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  return list
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("="))
    .join("; ");
}

function setCookieFlags(res: Response): string[] {
  return typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runSmoke(config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  const t0 = deps.now();
  const results: CheckResult[] = [];
  const add = (id: string, verdict: Verdict, detail: string) => results.push({ id, verdict, detail });
  const skipped = (g: string) => config.skip.has(g);

  // Every request goes through here: bypass header when set, no redirects followed for API calls.
  const call = (url: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (config.bypassToken) headers.set("x-vercel-protection-bypass", config.bypassToken);
    if (init.cookie) headers.set("cookie", init.cookie);
    headers.set("user-agent", "tearline-smoke/1");
    const { cookie: _c, ...rest } = init;
    return deps.fetch(url, { ...rest, headers });
  };

  const app = (p: string) => `${config.appUrl}${p}`;
  const site = (p: string) => `${config.siteUrl}${p}`;

  // ---- TLS ------------------------------------------------------------------------------------
  for (const [label, base] of [["app", config.appUrl], ["site", config.siteUrl]] as const) {
    const id = `tls.${label}`;
    if (skipped("tls")) {
      add(id, "skip", "switched off with --skip tls");
      continue;
    }
    try {
      const t = await deps.tlsProbe(base);
      if (!t.authorized) {
        add(id, "fail", `certificate not trusted: ${t.authorizationError ?? "unknown reason"}`);
        continue;
      }
      if (t.protocol && !/^TLSv1\.[23]$/.test(t.protocol)) {
        add(id, "fail", `negotiated ${t.protocol}, want TLSv1.2 or TLSv1.3`);
        continue;
      }
      const expiry = t.validTo ? Date.parse(t.validTo) : NaN;
      if (!Number.isFinite(expiry)) {
        add(id, "fail", "certificate expiry could not be read");
        continue;
      }
      const days = Math.floor((expiry - deps.now()) / 86_400_000);
      if (days < DEFAULTS.certMinDays) add(id, "fail", `certificate expires in ${days} days (${t.validTo})`);
      else if (days < DEFAULTS.certWarnDays) add(id, "warn", `certificate expires in ${days} days (${t.validTo})`);
      else add(id, "pass", `trusted, ${t.protocol ?? "protocol unknown"}, ${days} days left`);
    } catch (e) {
      add(id, "fail", `TLS probe failed: ${describeError(e)}`);
    }
  }

  // ---- Headers on both landings, and the site landing itself ----------------------------------
  let siteBody = "";
  let siteStatus = 0;
  for (const [label, url] of [["app", app("/")], ["site", site("/")]] as const) {
    const id = `headers.${label}`;
    const wantSite = label === "site" && !skipped("site");
    if (skipped("headers") && !wantSite) {
      add(id, "skip", "switched off with --skip headers");
      continue;
    }
    let res: Response;
    try {
      res = await call(url, { redirect: "follow" });
    } catch (e) {
      if (!skipped("headers")) add(id, "fail", `request failed: ${describeError(e)}`);
      if (wantSite) siteStatus = -1;
      continue;
    }
    if (label === "site") {
      siteStatus = res.status;
      siteBody = await readText(res);
    }
    if (skipped("headers")) {
      add(id, "skip", "switched off with --skip headers");
      continue;
    }
    const h = res.headers;
    const missing: string[] = [];
    const notes: string[] = [];
    if ((h.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options: nosniff");
    const csp = h.get("content-security-policy") ?? "";
    const xfo = (h.get("x-frame-options") ?? "").toUpperCase();
    if (!["DENY", "SAMEORIGIN"].includes(xfo) && !/frame-ancestors/i.test(csp)) missing.push("X-Frame-Options or CSP frame-ancestors");
    if (!h.get("referrer-policy")) missing.push("Referrer-Policy");
    const hsts = h.get("strict-transport-security") ?? "";
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? NaN);
    if (!(maxAge >= DEFAULTS.hstsMinSeconds)) missing.push(`Strict-Transport-Security max-age >= ${DEFAULTS.hstsMinSeconds}`);
    if (!csp) notes.push("no Content-Security-Policy");
    if (h.get("x-powered-by")) notes.push(`X-Powered-By is sent (${h.get("x-powered-by")})`);
    if (res.status >= 400) missing.push(`landing answered ${res.status}`);
    if (missing.length) add(id, "fail", `missing: ${missing.join(", ")}${notes.length ? `. Also: ${notes.join(", ")}` : ""}`);
    else if (notes.length) add(id, "warn", notes.join(", "));
    else add(id, "pass", "nosniff, frame policy, referrer policy, HSTS, CSP");
  }

  // ---- Health ---------------------------------------------------------------------------------
  const healthIds = ["health.ready", "health.storeDurable", "health.dataMode", "health.cacheBackend", "health.commit"];
  if (skipped("health")) {
    for (const id of healthIds) add(id, "skip", "switched off with --skip health");
  } else {
    let body: Record<string, unknown> | null = null;
    let why = "";
    try {
      const res = await call(app("/api/health"), { redirect: "manual" });
      if (res.status !== 200) why = `/api/health answered ${res.status}`;
      else {
        body = await readJson(res);
        if (!body) why = "/api/health did not return JSON";
        else if (body.status !== "ok") why = `status is ${JSON.stringify(body.status)}, not "ok"`;
        const cc = res.headers.get("cache-control") ?? "";
        if (body && !/no-store/i.test(cc)) add("health.cache-control", "warn", `Cache-Control is "${cc}", want no-store`);
      }
    } catch (e) {
      why = `request failed: ${describeError(e)}`;
    }
    if (!body || why) {
      for (const id of healthIds) add(id, "fail", why || "no health body");
    } else {
      const b = body;
      add("health.ready", b.ready === true ? "pass" : "fail", b.ready === true ? "ready true" : `ready is ${JSON.stringify(b.ready)}. A production secret is missing (the names are in the boot log, not over the wire)`);
      add("health.storeDurable", b.storeDurable === true ? "pass" : "fail", `storeDurable ${JSON.stringify(b.storeDurable)}`);
      add("health.dataMode", b.dataMode === "live" ? "pass" : "fail", `dataMode ${JSON.stringify(b.dataMode)}`);
      add("health.cacheBackend", b.cacheBackend === "upstash" ? "pass" : "fail", `cacheBackend ${JSON.stringify(b.cacheBackend)}`);
      const commit = typeof b.commit === "string" ? b.commit : "";
      if (!commit || commit === "dev") add("health.commit", "fail", `commit is ${JSON.stringify(b.commit)}. The deploy did not stamp VERCEL_GIT_COMMIT_SHA`);
      else if (config.expectCommit && !(commit.startsWith(config.expectCommit) || config.expectCommit.startsWith(commit)))
        add("health.commit", "fail", `commit ${commit.slice(0, 12)} is not the expected ${config.expectCommit.slice(0, 12)}`);
      else add("health.commit", "pass", `commit ${commit.slice(0, 12)}${config.expectCommit ? " matches" : " (no --expect-commit given)"}, region ${String(b.region ?? "unknown")}`);
    }
  }

  // ---- Login ----------------------------------------------------------------------------------
  let session: Session | null = null;
  const origin = new URL(config.appUrl).origin;
  if (skipped("login")) {
    add("login", "skip", "switched off with --skip login");
  } else if (!config.email || !config.password) {
    add("login", "fail", "SMOKE_EMAIL and SMOKE_PASSWORD are not both set");
  } else {
    try {
      // A wrong password first: it must be refused with the generic 401.
      const bad = await call(app("/api/auth/login"), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: config.email, password: `${config.password}-wrong` }),
      });
      if (bad.status !== 401) add("login.refuses-bad-password", "fail", `a wrong password answered ${bad.status}, want 401`);
      else add("login.refuses-bad-password", "pass", "wrong password refused with 401");

      const res = await call(app("/api/auth/login"), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: config.email, password: config.password }),
      });
      const body = await readJson(res);
      const cookie = cookieHeader(res);
      if (res.status !== 200 || body?.ok !== true) add("login", "fail", `sign-in answered ${res.status}${body?.error ? `: ${String(body.error)}` : ""}`);
      else if (!/(^|; )sid=/.test(cookie)) add("login", "fail", "sign-in answered 200 but set no session cookie");
      else {
        session = { cookie };
        const flags = setCookieFlags(res).filter((c) => /^sid(_h)?=/.test(c));
        const weak = flags.filter((c) => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c));
        if (config.appUrl.startsWith("https:") && weak.length) add("login", "fail", "signed in, but a session cookie lacks Secure or HttpOnly");
        else add("login", "pass", "signed in as the demo user, session cookie set");
      }
    } catch (e) {
      add("login", "fail", `request failed: ${describeError(e)}`);
    }
  }

  // ---- One run on the demo tenant -------------------------------------------------------------
  let sheetKey: string | null = null;
  let runId: string | null = null;
  if (skipped("run")) {
    add("run", "skip", "switched off with --skip run");
  } else if (!session) {
    add("run", "skip", "blocked: no signed-in session");
  } else if (!config.runInput) {
    add("run", "fail", "no run input. Set SMOKE_RUN_INPUT to one of the demo names' Companies House numbers");
  } else {
    try {
      const res = await call(app("/api/run"), {
        method: "POST",
        redirect: "manual",
        cookie: session.cookie,
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ input: config.runInput }),
      });
      const body = await readJson(res);
      if (res.status !== 202 || typeof body?.id !== "string") {
        add("run", "fail", `POST /api/run answered ${res.status}${body?.error ? `: ${String(body.error)}` : ""}`);
      } else {
        runId = body.id;
        const deadline = deps.now() + config.runTimeoutMs;
        let view: Record<string, unknown> | null = body;
        let polls = 0;
        while (view && view.status === "running" && deps.now() < deadline) {
          await deps.sleep(config.pollMs);
          const p = await call(app(`/api/run/${encodeURIComponent(runId)}`), { redirect: "manual", cookie: session.cookie });
          polls++;
          if (p.status !== 200) {
            view = null;
            add("run", "fail", `polling answered ${p.status} after ${polls} polls`);
            break;
          }
          view = await readJson(p);
        }
        if (view) {
          const status = String(view.status);
          const secs = Math.round(Number(view.elapsedMs ?? 0) / 1000);
          const name = view.companyName ? ` (${String(view.companyName)})` : "";
          if (status === "running") add("run", "fail", `still running after ${Math.round(config.runTimeoutMs / 1000)} s and ${polls} polls`);
          else if (status === "done" && typeof view.sheetKey === "string") {
            sheetKey = view.sheetKey;
            add("run", "pass", `done in ${secs} s${name}, ${polls} polls`);
          } else if (status === "partial" && typeof view.sheetKey === "string") {
            sheetKey = view.sheetKey;
            add("run", config.allowPartial ? "warn" : "fail", `partial in ${secs} s${name}: ${String(view.reason ?? "no reason given")}`);
          } else if (status === "needs-choice") {
            add("run", "fail", "the input matched several companies. Use a Companies House number");
          } else {
            add("run", "fail", `ended ${status}${view.reason ? `: ${String(view.reason)}` : ""}${view.sheetKey ? "" : ", no sheet key"}`);
          }
        }
      }
    } catch (e) {
      add("run", "fail", `request failed: ${describeError(e)}`);
    }
  }

  // The wall, signed out: the run just made (or a made-up id) must not be readable without a session.
  if (!skipped("run")) {
    try {
      const id = runId ?? "smoke-no-such-run";
      const res = await call(app(`/api/run/${encodeURIComponent(id)}`), { redirect: "manual" });
      if (res.status === 401 || res.status === 404) add("run.signed-out-wall", "pass", `signed-out read answered ${res.status}`);
      else add("run.signed-out-wall", "fail", `signed-out read of a run answered ${res.status}, want 401`);
    } catch (e) {
      add("run.signed-out-wall", "fail", `request failed: ${describeError(e)}`);
    }
  }

  // ---- One export -----------------------------------------------------------------------------
  if (skipped("export")) {
    add("export", "skip", "switched off with --skip export");
  } else if (!session || !sheetKey) {
    add("export", "skip", "blocked: no finished run to export");
  } else {
    try {
      const res = await call(app(`/api/model/${encodeURIComponent(sheetKey)}`), { redirect: "manual", cookie: session.cookie });
      const type = res.headers.get("content-type") ?? "";
      const buf = new Uint8Array(await res.arrayBuffer());
      const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK": xlsx is a zip
      if (res.status !== 200) add("export", "fail", `GET /api/model answered ${res.status}`);
      else if (!/spreadsheetml/i.test(type)) add("export", "fail", `content type is "${type}", want an .xlsx`);
      else if (!isZip || buf.length < 1000) add("export", "fail", `the body is not a workbook (${buf.length} bytes)`);
      else add("export", "pass", `.xlsx workbook, ${buf.length} bytes`);
    } catch (e) {
      add("export", "fail", `request failed: ${describeError(e)}`);
    }
  }

  // ---- Site landing ---------------------------------------------------------------------------
  if (skipped("site")) {
    add("site.landing", "skip", "switched off with --skip site");
  } else if (siteStatus === -1) {
    add("site.landing", "fail", "the site landing could not be fetched");
  } else {
    const problems: string[] = [];
    if (siteStatus !== 200) problems.push(`answered ${siteStatus}`);
    if (!/<title>/i.test(siteBody)) problems.push("no <title>");
    if (config.brandText && !siteBody.toLowerCase().includes(config.brandText.toLowerCase())) problems.push(`does not carry "${config.brandText}"`);
    if (/working title/i.test(siteBody)) problems.push('still says "working title"');
    if (/https?:\/\/[a-z0-9.-]+\.vercel\.app/i.test(siteBody)) problems.push("links to a vercel.app host");
    add("site.landing", problems.length ? "fail" : "pass", problems.length ? problems.join(", ") : `200, carries "${config.brandText}", no vercel.app links`);
  }

  // ---- Demo form. Nothing is ever sent: only an empty submission, which must be refused. -------
  if (skipped("demo")) {
    add("demo.page", "skip", "switched off with --skip demo");
    add("demo.refuses-empty", "skip", "switched off with --skip demo");
  } else {
    try {
      const res = await call(site("/demo"), { redirect: "follow" });
      const html = await readText(res);
      if (res.status !== 200) add("demo.page", "fail", `/demo answered ${res.status}`);
      else if (!/<form[\s>]/i.test(html)) add("demo.page", "fail", "/demo has no <form>");
      else add("demo.page", "pass", "/demo shows a form");
    } catch (e) {
      add("demo.page", "fail", `request failed: ${describeError(e)}`);
    }
    try {
      const res = await call(site("/api/demo"), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: new URL(config.siteUrl).origin },
        body: "{}",
      });
      if (res.status === 400 || res.status === 422) add("demo.refuses-empty", "pass", `an empty submission is refused with ${res.status}`);
      else if (res.status === 403 || res.status === 429) add("demo.refuses-empty", "warn", `refused with ${res.status}, not a validation error. Check the form by hand`);
      else if (res.status < 300) add("demo.refuses-empty", "fail", `an empty submission was accepted (${res.status})`);
      else add("demo.refuses-empty", "fail", `/api/demo answered ${res.status}`);
    } catch (e) {
      add("demo.refuses-empty", "fail", `request failed: ${describeError(e)}`);
    }
  }

  const anyFail = results.some((r) => r.verdict === "fail");
  const anySkip = results.some((r) => r.verdict === "skip");
  const verdict = anyFail ? "FAIL" : anySkip ? "INCOMPLETE" : "PASS";
  return {
    verdict,
    exitCode: anyFail ? 1 : anySkip ? 3 : 0,
    results,
    startedAt: new Date(t0).toISOString(),
    elapsedMs: deps.now() - t0,
    target: { app: config.appUrl, site: config.siteUrl },
  };
}

// --------------------------------------------------------------------------------------------
// Output. Only URLs, verdicts and details: no cookie, password or token can reach here.

export function renderText(r: SmokeReport): string {
  const lines = [`Smoke against app ${r.target.app} and site ${r.target.site}, ${r.startedAt}`, ""];
  for (const c of r.results) lines.push(`  ${c.verdict.toUpperCase().padEnd(4)}  ${c.id.padEnd(26)} ${c.detail}`);
  const n = (v: Verdict) => r.results.filter((c) => c.verdict === v).length;
  lines.push("", `${r.verdict}: ${n("pass")} pass, ${n("fail")} fail, ${n("warn")} warn, ${n("skip")} skip, ${Math.round(r.elapsedMs / 1000)} s`);
  return lines.join("\n");
}

export function renderMarkdown(r: SmokeReport): string {
  const rows = r.results.map((c) => `| ${c.id} | ${c.verdict.toUpperCase()} | ${c.detail.replace(/\|/g, "\\|")} |`);
  return [
    `# Smoke run, ${r.startedAt}`,
    "",
    `App ${r.target.app}. Site ${r.target.site}. Verdict **${r.verdict}**.`,
    "",
    "| Check | Verdict | Detail |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function renderPlan(c: SmokeConfig): string {
  const yes = (v: unknown) => (v ? "set" : "NOT SET");
  const s = (g: string) => (c.skip.has(g) ? "  (skipped)" : "");
  return [
    "Dry run. No request is sent.",
    "",
    `  app            ${c.appUrl}`,
    `  site           ${c.siteUrl}`,
    `  SMOKE_EMAIL    ${yes(c.email)}`,
    `  SMOKE_PASSWORD ${yes(c.password)}`,
    `  bypass token   ${c.bypassToken ? "set (sent as x-vercel-protection-bypass)" : "not set"}`,
    `  run input      ${c.runInput ?? "NOT SET"}`,
    `  expect commit  ${c.expectCommit ?? "any real commit"}`,
    `  run timeout    ${Math.round(c.runTimeoutMs / 1000)} s${c.allowPartial ? ", partial allowed" : ""}`,
    "",
    "Plan:",
    `  tls       TLS handshake to both hosts: trusted, TLS 1.2+, ${DEFAULTS.certMinDays}+ days left${s("tls")}`,
    `  headers   GET ${c.appUrl}/ and ${c.siteUrl}/: nosniff, frame policy, Referrer-Policy, HSTS${s("headers")}`,
    `  health    GET ${c.appUrl}/api/health: ready, storeDurable, dataMode live, cacheBackend upstash, commit${s("health")}`,
    `  login     POST ${c.appUrl}/api/auth/login: a wrong password is refused, then the demo user signs in${s("login")}`,
    `  run       POST ${c.appUrl}/api/run, poll /api/run/<id> to done, then a signed-out read must be refused${s("run")}`,
    `  export    GET ${c.appUrl}/api/model/<sheetKey>: an .xlsx workbook${s("export")}`,
    `  site      ${c.siteUrl}/ carries "${c.brandText}", no "working title", no vercel.app link${s("site")}`,
    `  demo      GET ${c.siteUrl}/demo shows a form, POST {} to /api/demo is refused (nothing is sent)${s("demo")}`,
  ].join("\n");
}
