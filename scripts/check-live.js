// Checks the deployed page in headless Chrome (DEV-001, DEV-002): content,
// and that a push shows up without a page reload.
//
// Run from the repository root:
//   node sst/test/browser/cdp.mjs <page url> sst-dev/scripts/check-live.js
const { execFileSync } = await import("node:child_process");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const dir = join(process.cwd(), "sst-dev");
const outputs = JSON.parse(readFileSync(join(dir, ".sst", "outputs.json"), "utf8"));

await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false });
await page.goto(outputs.url);
await page.sleep(3000);
const r = {
  url: outputs.url,
  pct: await page.eval("document.querySelector('.pct')?.textContent"),
  specs: await page.eval("document.querySelectorAll('tr.spec').length"),
  files: await page.eval("document.querySelectorAll('.now + .commits li').length"),
  before: await page.eval("document.querySelector('.live')?.textContent"),
};
await page.eval("window.__kept = true");
// Wait so the next push has a visibly newer timestamp, then push.
await page.sleep(20000);
r.beforePush = await page.eval("document.querySelector('.live')?.textContent");
execFileSync("node", ["scripts/push.mjs", "--quiet"], { cwd: dir });
await page.sleep(17000);
r.afterPush = await page.eval("document.querySelector('.live')?.textContent");
r.noReload = await page.eval("window.__kept === true");
await page.shot(process.env.SHOT ?? "/tmp/status-live.png");
const ok = r.specs >= 41 && /%/.test(r.pct) && r.noReload && /updated \d+ s ago/.test(r.afterPush) && r.afterPush !== r.beforePush;
if (!ok) process.exitCode = 1;
return { ...r, ok };
