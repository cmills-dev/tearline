// WP-QA06 round 2 browser walk: the invite link end to end, then every page as tenant A,
// recording HTTP status, CSP violations, console errors and page errors.
const { chromium } = require("/Users/student/dev/origination-wt/merge-evening-0927/product/node_modules/playwright-core");
const BASE = process.env.BASE;
const out = [];
const log = (id, ok, note) => { out.push({ id, ok, note }); console.log(`${ok ? "OK  " : "BUG "} ${id}: ${note}`); };

async function watch(page) {
  const issues = [];
  page.on("console", (m) => { if (m.type() === "error") issues.push(`console: ${m.text().slice(0, 160)}`); });
  page.on("pageerror", (e) => issues.push(`pageerror: ${String(e).slice(0, 160)}`));
  return issues;
}

(async () => {
  const browser = await chromium.launch();
  // 1. Invite link.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const issues = await watch(page);
    await page.goto(`${BASE}/login?invite=${encodeURIComponent(process.env.INVITE)}`, { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    log("invite link opens register", /create|register|sign up/i.test(text), text.replace(/\s+/g, " ").slice(0, 120));
    await page.fill('input[type="email"]', process.env.C_EMAIL);
    await page.fill('input[type="password"]', process.env.C_PASS);
    await Promise.all([page.waitForLoadState("networkidle"), page.locator('button[type="submit"]').click()]);
    await page.waitForTimeout(2500);
    const cookies = (await ctx.cookies()).map((c) => c.name);
    const err = await page.locator("body").innerText();
    log("invited user registers in the browser", cookies.length > 0 && !/invite|incorrect|error/i.test(err.slice(0, 400)), `url ${page.url()} cookies ${cookies.join(",")} ${issues.join(" | ")}`);
    await ctx.close();
  }
  // 2. Every page as tenant A.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const issues = await watch(page);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', process.env.A_EMAIL);
  await page.fill('input[type="password"]', process.env.A_PASS);
  await Promise.all([page.waitForLoadState("networkidle"), page.locator('button[type="submit"]').click()]);
  await page.waitForTimeout(2000);
  log("login in the browser", (await ctx.cookies()).length > 0, page.url());
  const paths = ["/", "/workspace", "/sheet/meridian", "/sheet/qa06-secret", "/originate", "/live", "/watchlist", "/pipeline", "/review", "/screen", "/kb", "/housesheet", "/onboarding", "/onboarding/assistant", "/shared-learning", "/esef", "/sec",
    "/api/export/deck/qa06-secret", "/api/export/references/qa06-secret?format=html", "/no-such-page"];
  for (const p of paths) {
    issues.length = 0;
    let status = 0;
    try {
      const res = await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 60000 });
      status = res ? res.status() : 0;
      await page.waitForTimeout(800);
    } catch (e) { issues.push(`goto: ${String(e).slice(0, 120)}`); }
    const csp = issues.filter((i) => /content security policy|refused to/i.test(i));
    const ok = (status < 400 || p === "/no-such-page") && csp.length === 0 && !issues.some((i) => i.startsWith("pageerror"));
    log(`page ${p}`, ok, `status ${status}${issues.length ? " | " + issues.slice(0, 4).join(" | ") : ""}`);
  }
  await browser.close();
  require("fs").writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(2); });
