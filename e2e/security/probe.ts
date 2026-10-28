// e2e/security/probe.ts (WP-QA06)
// The security probe over HTTP: two-tenant attacks, cookie tampering, CSRF Origin, headers,
// size caps and the login limit. It runs against a live server and changes nothing but the two
// probe users' own sessions. Run it from product/ against the local preview:
//
//   BASE=http://127.0.0.1:3126 A_EMAIL=... A_PASS=... B_EMAIL=... B_PASS=... \
//   AUTH_SECRET=... SECRET_KEY=qa06-secret SECRET_RUN=qa06-run-a SECRET_MARK=QA06-SECRET-A \
//   npx tsx e2e/security/probe.ts
//
// e2e/security/setup.sh makes the two users and plants tenant A's secret sheet and run.
// Every check prints PASS, FIND (a security finding, with evidence) or SKIP. Exit code 1 when a
// cross-tenant read or a cookie bypass is seen, the two outcomes that must never ship.
// AUTH_SECRET is used only to mint an expired and a tenant-swapped envelope, the attacks an
// attacker with a leaked secret or a stolen old cookie would try.

import { createHmac } from "node:crypto";

const BASE = (process.env.BASE ?? "http://127.0.0.1:3126").replace(/\/$/, "");
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const SECRET_KEY = process.env.SECRET_KEY ?? "qa06-secret";
const SECRET_RUN = process.env.SECRET_RUN ?? "qa06-run-a";
const MARK = process.env.SECRET_MARK ?? "QA06-SECRET-A";

type Result = { id: string; outcome: "PASS" | "FIND" | "SKIP"; severity?: string; evidence: string; blocking?: boolean };
const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
  console.log(`${r.outcome.padEnd(4)} ${r.id}${r.severity ? ` [${r.severity}]` : ""}: ${r.evidence}`);
};

class Jar {
  c = new Map<string, string>();
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === "" || /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) this.c.delete(k);
      else this.c.set(k, v);
    }
  }
  clone() {
    const j = new Jar();
    j.c = new Map(this.c);
    return j;
  }
}

async function req(path: string, opts: { jar?: Jar; method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.jar && opts.jar.c.size) headers.cookie = opts.jar.header();
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(BASE + path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  opts.jar?.take(res);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function login(email: string, password: string) {
  const jar = new Jar();
  const r = await req("/api/auth/login", { jar, body: { email, password }, headers: { origin: BASE } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${r.text.slice(0, 200)}`);
  return jar;
}

function b64url(s: string) {
  return Buffer.from(s).toString("base64url");
}
// Mirrors lib/auth/crypto.ts sign(): payload.b64url + "." + hmac. Read from the cookie we hold,
// so if the format changes the tamper checks say SKIP instead of lying.
function reSign(cookie: string, mutate: (s: Record<string, unknown>) => void, secret: string): string | null {
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadPart = decodeURIComponent(cookie.slice(0, dot));
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  mutate(json);
  const p = b64url(JSON.stringify(json));
  const sig = createHmac("sha256", secret).update(p).digest("base64url");
  return `${p}.${sig}`;
}

const leaks = (text: string) => text.includes(MARK);

async function tenantReads(label: string, jar: Jar, expectMark: boolean) {
  const paths = [
    `/api/model/${SECRET_KEY}`,
    `/api/export/deck/${SECRET_KEY}`,
    `/api/export/references/${SECRET_KEY}?format=csv`,
    `/api/export/references/${SECRET_KEY}?format=html`,
    `/api/run/${SECRET_RUN}`,
    `/sheet/${SECRET_KEY}`,
    `/workspace`,
    `/api/onboarding/state`,
  ];
  let seen = 0;
  for (const p of paths) {
    const r = await req(p, { jar });
    const hit = leaks(r.text);
    if (hit) seen++;
    if (!expectMark && hit) record({ id: `xtenant ${label} ${p}`, outcome: "FIND", severity: "critical", blocking: true, evidence: `status ${r.status}, body carries ${MARK}` });
    else if (!expectMark) record({ id: `xtenant ${label} ${p}`, outcome: "PASS", evidence: `status ${r.status}, no ${MARK}` });
  }
  return seen;
}

async function main() {
  const A = await login(env("A_EMAIL"), env("A_PASS"));
  const B = await login(env("B_EMAIL"), env("B_PASS"));
  const secret = process.env.AUTH_SECRET;

  // 0. Control: A must see its own secret, or the cross-tenant checks prove nothing.
  const own = await tenantReads("A-own", A, true);
  record({ id: "control A reads own", outcome: own > 0 ? "PASS" : "SKIP", evidence: `${own} of 8 paths show ${MARK} to A` });

  // 1. Two tenants: by key, by list, by crafted API call.
  await tenantReads("B", B, false);
  await tenantReads("anon", new Jar(), false);

  // A's onboarding state written by A, read by B.
  await req("/api/onboarding/state", { jar: A, body: { firmName: `${MARK}-firm` }, headers: { origin: BASE } });
  const bState = await req("/api/onboarding/state", { jar: B });
  record({ id: "xtenant onboarding/state", outcome: leaks(bState.text) ? "FIND" : "PASS", severity: leaks(bState.text) ? "critical" : undefined, blocking: leaks(bState.text), evidence: `B GET ${bState.status}` });

  // Watchlist by list.
  await req("/api/monitor", { jar: A, body: { action: "add", chNumber: "09999999" }, headers: { origin: BASE } });
  const bList = await req("/api/monitor", { jar: B, body: { action: "list" }, headers: { origin: BASE } });
  const wl = bList.text.includes("09999999");
  record({ id: "xtenant monitor list", outcome: wl ? "FIND" : "PASS", severity: wl ? "critical" : undefined, blocking: wl, evidence: `B list ${bList.status}, A's 09999999 ${wl ? "present" : "absent"}` });
  await req("/api/monitor", { jar: A, body: { action: "remove", chNumber: "09999999" }, headers: { origin: BASE } });

  // Crafted: tenant id in the body, query and header are ignored.
  const crafted = await req(`/api/model/${SECRET_KEY}?tenantId=a&tenant=a`, { jar: B, headers: { "x-tenant-id": "a", "x-tenant": "a" } });
  record({ id: "xtenant crafted tenant params", outcome: leaks(crafted.text) ? "FIND" : "PASS", severity: leaks(crafted.text) ? "critical" : undefined, blocking: leaks(crafted.text), evidence: `status ${crafted.status}` });
  const craftedRun = await req("/api/run", { jar: B, body: { input: "x", tenantId: "a" }, headers: { origin: BASE } });
  record({ id: "xtenant crafted run body", outcome: leaks(craftedRun.text) ? "FIND" : "PASS", evidence: `status ${craftedRun.status}` });

  // 2. Cookies: forged, expired, revoked, swapped.
  const sid = A.c.get("sid");
  const sidh = A.c.get("sid_h");
  if (!sid || !sidh) record({ id: "cookie shape", outcome: "SKIP", evidence: `cookies seen: ${[...A.c.keys()].join(",")}` });
  else {
    const flip = A.clone();
    flip.c.set("sid", sid.slice(0, -2) + (sid.endsWith("AA") ? "BB" : "AA"));
    const r1 = await req(`/api/model/${SECRET_KEY}`, { jar: flip });
    record({ id: "cookie forged signature", outcome: leaks(r1.text) ? "FIND" : "PASS", blocking: leaks(r1.text), evidence: `status ${r1.status}` });

    const noH = A.clone();
    noH.c.delete("sid_h");
    const r2 = await req(`/api/model/${SECRET_KEY}`, { jar: noH });
    record({ id: "cookie sid without handle", outcome: leaks(r2.text) ? "FIND" : "PASS", blocking: leaks(r2.text), evidence: `status ${r2.status}` });

    const mixed = B.clone();
    mixed.c.set("sid", sid);
    const r3 = await req(`/api/model/${SECRET_KEY}`, { jar: mixed });
    record({ id: "cookie A sid + B handle", outcome: leaks(r3.text) ? "FIND" : "PASS", blocking: leaks(r3.text), evidence: `status ${r3.status}` });

    if (secret) {
      const expired = reSign(sid, (s) => (s.exp = Math.floor(Date.now() / 1000) - 60), secret);
      if (expired) {
        const j = A.clone();
        j.c.set("sid", expired);
        const r = await req(`/api/model/${SECRET_KEY}`, { jar: j });
        record({ id: "cookie expired (validly signed)", outcome: leaks(r.text) ? "FIND" : "PASS", blocking: leaks(r.text), evidence: `status ${r.status}` });
        const noExp = reSign(sid, (s) => delete s.exp, secret)!;
        j.c.set("sid", noExp);
        const r4 = await req(`/api/model/${SECRET_KEY}`, { jar: j });
        record({ id: "cookie without exp (validly signed)", outcome: leaks(r4.text) ? "FIND" : "PASS", severity: leaks(r4.text) ? "low" : undefined, evidence: `status ${r4.status}; the handle row still bounds the session` });
        // B's handle with an envelope that claims tenant A: needs the secret, the defence in depth.
        const bSid = B.c.get("sid")!;
        const aTenant = JSON.parse(Buffer.from(decodeURIComponent(sid.slice(0, sid.lastIndexOf("."))), "base64url").toString()).tenantId;
        const swapped = reSign(bSid, (s) => (s.tenantId = aTenant), secret)!;
        const j2 = B.clone();
        j2.c.set("sid", swapped);
        const r5 = await req(`/api/model/${SECRET_KEY}`, { jar: j2 });
        record({ id: "cookie tenant-swapped (validly signed)", outcome: leaks(r5.text) ? "FIND" : "PASS", blocking: leaks(r5.text), evidence: `status ${r5.status}` });
      } else record({ id: "cookie expired", outcome: "SKIP", evidence: "envelope format not recognised" });
    } else record({ id: "cookie expired", outcome: "SKIP", evidence: "AUTH_SECRET not given" });

    // Revoked: log A out, replay the old pair.
    const stolen = A.clone();
    await req("/api/auth/logout", { jar: A, method: "POST", headers: { origin: BASE } });
    const r6 = await req(`/api/model/${SECRET_KEY}`, { jar: stolen });
    record({ id: "cookie revoked by logout, replayed", outcome: leaks(r6.text) ? "FIND" : "PASS", blocking: leaks(r6.text), evidence: `status ${r6.status}` });
  }

  // 3. CSRF: a state change from another origin, and with no Origin at all.
  const Bx = await login(env("B_EMAIL"), env("B_PASS"));
  const evil = await req("/api/onboarding/state", { jar: Bx, body: { firmName: "csrf-evil-origin" }, headers: { origin: "https://evil.example" } });
  record({ id: "csrf cross Origin POST (json)", outcome: evil.status < 400 ? "FIND" : "PASS", severity: evil.status < 400 ? "medium" : undefined, evidence: `status ${evil.status} with Origin https://evil.example` });
  const plain = await req("/api/onboarding/state", { jar: Bx, raw: JSON.stringify({ firmName: "csrf-text-plain" }), headers: { origin: "https://evil.example", "content-type": "text/plain" } });
  record({ id: "csrf cross Origin POST (text/plain, no preflight)", outcome: plain.status < 400 ? "FIND" : "PASS", severity: plain.status < 400 ? "medium" : undefined, evidence: `status ${plain.status}; SameSite=Lax keeps the cookie off a real cross-site POST, so this needs a same-site attacker` });
  const loginCsrf = await req("/api/auth/login", { body: { email: env("B_EMAIL"), password: env("B_PASS") }, headers: { origin: "https://evil.example", "content-type": "text/plain" } });
  record({ id: "csrf login from another origin", outcome: loginCsrf.status === 200 ? "FIND" : "PASS", severity: loginCsrf.status === 200 ? "medium" : undefined, evidence: `status ${loginCsrf.status}: login CSRF signs a victim into the attacker's desk` });
  // Flags are read off a same-origin login: the cross-origin one above is refused once S4 is fixed.
  const sameOrigin = await req("/api/auth/login", { body: { email: env("B_EMAIL"), password: env("B_PASS") }, headers: { origin: BASE } });
  const setCookie = sameOrigin.headers.get("set-cookie") ?? "";
  record({ id: "cookie flags", outcome: /httponly/i.test(setCookie) && /samesite=lax|samesite=strict/i.test(setCookie) ? "PASS" : "FIND", evidence: setCookie.split(",").map((s) => s.split(";").slice(1).join(";")).join(" | ").slice(0, 200) });

  // 4. Headers on the app.
  const home = await req("/login");
  const h = home.headers;
  const want: [string, string][] = [
    ["content-security-policy", "high"],
    ["strict-transport-security", "medium"],
    ["x-frame-options", "medium"],
    ["x-content-type-options", "low"],
    ["referrer-policy", "low"],
    ["permissions-policy", "low"],
  ];
  for (const [name, sev] of want) record({ id: `header ${name}`, outcome: h.get(name) ? "PASS" : "FIND", severity: h.get(name) ? undefined : sev, evidence: h.get(name) ?? "absent under next start" });
  record({ id: "header x-powered-by", outcome: h.get("x-powered-by") ? "FIND" : "PASS", severity: h.get("x-powered-by") ? "info" : undefined, evidence: h.get("x-powered-by") ?? "absent" });

  // 5. Size caps.
  const big = "a".repeat(20 * 1024 * 1024);
  const t0 = Date.now();
  const sized = await req("/api/auth/login", { raw: JSON.stringify({ email: big, password: "x" }), headers: { "content-type": "application/json", origin: BASE } }).catch((e) => ({ status: 0, text: String(e), headers: new Headers() }));
  record({ id: "size cap 20 MB login body", outcome: sized.status === 413 ? "PASS" : "FIND", severity: sized.status === 413 ? undefined : "medium", evidence: `status ${sized.status} in ${Date.now() - t0} ms${sized.status === 413 ? "" : " (read whole before any cap)"}` });

  // 6. Unauthenticated surfaces.
  const health = await req("/api/health");
  record({ id: "health disclosure", outcome: "FIND", severity: "low", evidence: health.text.slice(0, 220) });
  const kb = await req("/api/kb/entities");
  record({ id: "kb read without session", outcome: kb.status === 401 ? "PASS" : "FIND", severity: kb.status === 401 ? undefined : "low", evidence: `status ${kb.status}` });
  const ingest = await req("/api/kb/ingest", { body: { key: "meridian" }, headers: { origin: BASE } });
  record({ id: "kb ingest without session", outcome: ingest.status === 401 ? "PASS" : "FIND", severity: ingest.status === 401 ? undefined : "low", evidence: `status ${ingest.status}` });
  const cron = await req("/api/cron/monitor", { headers: { "x-vercel-cron": "1" } });
  record({ id: "cron with spoofed x-vercel-cron", outcome: cron.status === 401 || cron.status === 403 ? "PASS" : "FIND", severity: cron.status < 400 ? "high" : undefined, evidence: `status ${cron.status}` });
  const shared = await req("/api/onboarding/shared", { jar: Bx, body: { action: "promote", id: "x" }, headers: { origin: BASE } });
  record({ id: "shared promote without admin secret", outcome: shared.status === 401 || shared.status === 403 ? "PASS" : "FIND", severity: shared.status < 400 ? "high" : undefined, evidence: `status ${shared.status}` });

  // 7. Login limit, with the client choosing its own IP (x-real-ip) and without.
  if (process.env.SKIP_LIMIT !== "1") {
    const victim = env("B_EMAIL");
    let first429 = 0;
    for (let i = 1; i <= 24; i++) {
      const r = await req("/api/auth/login", { body: { email: `nobody${i}-qa06@preview.local`, password: "wrong-password" }, headers: { origin: BASE, "x-real-ip": "203.0.113.9" } });
      if (r.status === 429 && !first429) first429 = i;
    }
    record({ id: "login limit per IP (fixed IP)", outcome: first429 ? "PASS" : "FIND", severity: first429 ? undefined : "high", evidence: first429 ? `429 at attempt ${first429}` : "no 429 in 24 attempts (limit is 20 per 5 min)" });
    let rotated429 = 0;
    for (let i = 1; i <= 24; i++) {
      const r = await req("/api/auth/login", { body: { email: `other${i}-qa06@preview.local`, password: "wrong-password" }, headers: { origin: BASE, "x-real-ip": `198.51.100.${i}` } });
      if (r.status === 429 && !rotated429) rotated429 = i;
    }
    record({ id: "login limit per IP with rotated x-real-ip", outcome: rotated429 ? "PASS" : "FIND", severity: rotated429 ? undefined : "medium", evidence: rotated429 ? `429 at ${rotated429}` : "no 429 in 24 attempts (limit is 20 per 5 min): the client picks its own IP off Vercel" });
    void victim;
  }

  const blocking = results.filter((r) => r.blocking);
  console.log(`\nSUMMARY: ${results.filter((r) => r.outcome === "PASS").length} pass, ${results.filter((r) => r.outcome === "FIND").length} find, ${results.filter((r) => r.outcome === "SKIP").length} skip, ${blocking.length} blocking`);
  if (process.env.JSON_OUT) (await import("node:fs")).writeFileSync(process.env.JSON_OUT, JSON.stringify(results, null, 2));
  process.exit(blocking.length ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
