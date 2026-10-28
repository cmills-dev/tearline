// WP-QA06 round 2 browser walk, part 2: anonymous and tenant B against A's sheet, /live, and the site.
// Records status, CSP violations, page errors and whether A's marker is visible. Changes nothing but a session.
const { chromium } = require("/Users/student/dev/origination-wt/merge-evening-0927/product/node_modules/playwright-core");
const BASE = process.env.BASE, SITE = process.env.SITE, KEY = process.env.SECRET_KEY, MARK = process.env.SECRET_MARK;
(async () => {
  const browser = await chromium.launch();
  const out = [];
  async function walk(ctx, base, paths, who) {
    for (const p of paths) {
      const page = await ctx.newPage();
      const csp = [], errs = [];
      page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); else if (m.type() === "error" && !/404/.test(t)) errs.push(t.slice(0, 200)); });
      page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 200)));
      let status = 0, finalUrl = "";
      try { const r = await page.goto(base + p, { waitUntil: p === "/live" ? "load" : "networkidle", timeout: 45000 }); status = r ? r.status() : 0; finalUrl = page.url().replace(base, ""); }
      catch (e) { errs.push("goto: " + String(e).split("\n")[0].slice(0, 150)); }
      await page.waitForTimeout(1500);
      const marker = (await page.content()).includes(MARK);
      out.push({ who, path: p, status, finalUrl, csp, errs, marker });
      await page.close();
    }
  }
  await walk(await browser.newContext(), BASE, ["/workspace", "/sheet/" + KEY], "anon");
  const ctx = await browser.newContext();
  const r = await ctx.request.post(BASE + "/api/auth/login", { data: { email: process.env.B_EMAIL, password: process.env.B_PASS }, headers: { origin: BASE } });
  if (r.status() !== 200) { console.log("login B", r.status()); process.exit(2); }
  await walk(ctx, BASE, ["/workspace", "/sheet/" + KEY, "/live", "/pipeline", "/watchlist"], "B");
  if (SITE) await walk(await browser.newContext(), SITE, ["/", "/nope-404"], "site");
  await browser.close();
  let bad = 0;
  for (const o of out) {
    const flag = o.csp.length || o.errs.length || o.marker;
    if (flag) bad++;
    console.log(`${flag ? "LOOK" : "ok  "} ${o.who.padEnd(4)} ${String(o.status).padEnd(4)} ${o.path} -> ${o.finalUrl}${o.marker ? " [A's marker visible]" : ""}`);
    for (const c of o.csp) console.log("      csp: " + c);
    for (const e of o.errs) console.log("      err: " + e);
  }
  console.log(`WALK2: ${out.length} pages, ${bad} to look at`);
})().catch((e) => { console.error(e); process.exit(2); });
