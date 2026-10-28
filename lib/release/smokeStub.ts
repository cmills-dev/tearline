// lib/release/smokeStub.ts (WP-QA08)
// A local stand-in for a deployed app and site, so `smoke-prod.ts --self-test` can run every
// check over real HTTP on 127.0.0.1 before any preview exists. It imitates the shapes the real
// routes return (app/api/health, app/api/auth/login, app/api/run, app/api/run/[id],
// app/api/model/[key]) and what the site is meant to serve once WP-SS06 lands (/demo, /api/demo).
//
// Two profiles. "good" is a healthy production. "broken" is the deploy the smoke must refuse:
// fixtures data, an in-memory store, a dev commit, no HSTS and a demo form that accepts anything.
// The self-test passes only if the smoke passes the first and fails the second.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runSmoke, DEFAULTS, type SmokeReport, type TlsInfo } from "./smoke";

export type StubProfile = "good" | "broken";

export const STUB_EMAIL = "demo@stub.invalid";
export const STUB_PASSWORD = "stub-password-not-a-secret";
export const STUB_RUN_INPUT = "00000001";

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string | string[]>, payload: string | Buffer) {
  res.writeHead(status, headers);
  res.end(payload);
}

function securityHeaders(profile: StubProfile): Record<string, string> {
  const h: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
  };
  if (profile === "good") h["strict-transport-security"] = "max-age=63072000; includeSubDomains";
  return h;
}

// A minimal zip header plus padding: enough for the "is this a workbook" check, not a real file.
function fakeXlsx(): Buffer {
  const b = Buffer.alloc(2048, 0);
  b.write("PK\u0003\u0004", 0, "binary");
  return b;
}

export interface StubServers {
  appUrl: string;
  siteUrl: string;
  close: () => Promise<void>;
}

export async function startStub(profile: StubProfile): Promise<StubServers> {
  let polls = 0;
  const sec = securityHeaders(profile);
  const json = (res: ServerResponse, status: number, v: unknown, extra: Record<string, string | string[]> = {}) =>
    send(res, status, { ...sec, "content-type": "application/json", "cache-control": "no-store", ...extra }, JSON.stringify(v));
  const signedIn = (req: IncomingMessage) => /(^|;\s*)sid=stub-session/.test(req.headers.cookie ?? "");

  const app = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const p = url.pathname;
    if (req.method === "GET" && p === "/") {
      return send(res, 200, { ...sec, "content-type": "text/html" }, "<!doctype html><title>Tearline</title><p>Sign in</p>");
    }
    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, {
        status: "ok",
        contractVersion: "stub",
        dataMode: profile === "good" ? "live" : "fixtures",
        llm: "on",
        storeDurable: profile === "good",
        cacheBackend: profile === "good" ? "upstash" : "memory",
        ready: true,
        region: "lhr1",
        commit: profile === "good" ? "0123456789abcdef0123456789abcdef01234567" : "dev",
        time: new Date().toISOString(),
      });
    }
    if (req.method === "POST" && p === "/api/auth/login") {
      const b = JSON.parse((await body(req)) || "{}");
      if (b.email !== STUB_EMAIL || b.password !== STUB_PASSWORD) return json(res, 401, { error: "Incorrect email or password." });
      return json(res, 200, { ok: true, email: STUB_EMAIL }, {
        "set-cookie": ["sid=stub-session; Path=/; HttpOnly; SameSite=Lax", "sid_h=stub-handle; Path=/; HttpOnly; SameSite=Lax"],
      });
    }
    if (req.method === "POST" && p === "/api/run") {
      if (!signedIn(req)) return json(res, 401, { error: "You must be signed in." });
      await body(req);
      polls = 0;
      return json(res, 202, { id: "run-stub-1", status: "running", stages: [], poll: "/api/run/run-stub-1" });
    }
    if (req.method === "GET" && p.startsWith("/api/run/")) {
      if (!signedIn(req)) return json(res, 401, { error: "You must be signed in." });
      polls++;
      const done = polls >= 2;
      return json(res, 200, {
        id: "run-stub-1",
        status: done ? "done" : "running",
        elapsedMs: polls * 1000,
        companyName: "STUB HOLDINGS LIMITED",
        sheetKey: done ? "stub-sheet" : null,
        reason: null,
      });
    }
    if (req.method === "GET" && p.startsWith("/api/model/")) {
      if (!signedIn(req)) return json(res, 401, { error: "You must be signed in." });
      return send(res, 200, {
        ...sec,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="stub.xlsx"',
      }, fakeXlsx());
    }
    return json(res, 404, { error: "not found" });
  });

  const site = createServer(async (req, res) => {
    const p = new URL(req.url ?? "/", "http://stub").pathname;
    if (req.method === "GET" && p === "/") {
      return send(res, 200, { ...sec, "content-type": "text/html" }, "<!doctype html><title>Tearline</title><h1>Tearline</h1><a href=\"/demo\">Book a demo</a>");
    }
    if (req.method === "GET" && p === "/demo") {
      return send(res, 200, { ...sec, "content-type": "text/html" }, "<!doctype html><title>Demo</title><form method=\"post\"><input name=\"email\"></form>");
    }
    if (req.method === "POST" && p === "/api/demo") {
      await body(req);
      if (profile === "good") return send(res, 400, { ...sec, "content-type": "application/json" }, JSON.stringify({ error: "Name and email are required." }));
      return send(res, 200, { ...sec, "content-type": "application/json" }, JSON.stringify({ ok: true }));
    }
    return send(res, 404, sec, "not found");
  });

  const listen = (s: Server) =>
    new Promise<string>((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const appUrl = await listen(app);
  const siteUrl = await listen(site);
  const closeOne = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));
  return { appUrl, siteUrl, close: async () => void (await Promise.all([closeOne(app), closeOne(site)])) };
}

// The stub has no certificate, so the self-test hands the smoke a probe that answers as a real
// host with a good certificate would. Only the self-test uses it.
export function stubTlsProbe(now: number): (url: string) => Promise<TlsInfo> {
  const validTo = new Date(now + 90 * 86_400_000).toUTCString();
  return async () => ({ authorized: true, authorizationError: null, protocol: "TLSv1.3", validTo });
}

// The checks the broken profile must trip. If any passes, the smoke has lost its teeth.
export const BROKEN_MUST_FAIL = [
  "headers.app",
  "headers.site",
  "health.storeDurable",
  "health.dataMode",
  "health.cacheBackend",
  "health.commit",
  "demo.refuses-empty",
];

export interface SelfTestResult {
  ok: boolean;
  good: SmokeReport;
  broken: SmokeReport;
  missed: string[]; // broken-profile checks that should have failed and did not
}

export async function runSelfTest(): Promise<SelfTestResult> {
  const one = async (profile: StubProfile): Promise<SmokeReport> => {
    const stub = await startStub(profile);
    try {
      return await runSmoke(
        {
          appUrl: stub.appUrl,
          siteUrl: stub.siteUrl,
          email: STUB_EMAIL,
          password: STUB_PASSWORD,
          runInput: STUB_RUN_INPUT,
          expectCommit: null,
          bypassToken: null,
          brandText: DEFAULTS.brandText,
          runTimeoutMs: 10_000,
          pollMs: 10,
          allowPartial: false,
          skip: new Set(),
        },
        {
          fetch: globalThis.fetch.bind(globalThis),
          tlsProbe: stubTlsProbe(Date.now()),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
        },
      );
    } finally {
      await stub.close();
    }
  };
  const good = await one("good");
  const broken = await one("broken");
  const missed = BROKEN_MUST_FAIL.filter((id) => broken.results.find((r) => r.id === id)?.verdict !== "fail");
  return { ok: good.verdict === "PASS" && broken.verdict === "FAIL" && missed.length === 0, good, broken, missed };
}
