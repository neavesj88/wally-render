/**
 * Renders a TripTrail route animation on a GPU-less CI runner.
 *
 * TripTrail (MIT, © 2026 Fangyuan Lin) is cloned and served locally rather
 * than driven on its author's Vercel deployment — automating someone else's
 * free hosting is not ours to spend.
 *
 * The route is injected the same way a console paste would do it: its app.js
 * is a classic script, so top-level `stops`, `id()` and `afterStopsChange()`
 * are reachable. Settings go in through the DOM inputs, never the `settings`
 * object — play() calls syncSettingsFromUI() first and would overwrite it.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TRIPTRAIL_URL || "http://localhost:8080";
const OUT_DIR = process.env.OUT_DIR || "out";
const ACCENT = process.env.ACCENT || "#AB30E8";

const payload = JSON.parse(process.env.ROUTE_JSON || "{}");
const stops = payload.stops || [];
const title = payload.title || "Where's Wally";
const subtitle = payload.subtitle || "";
const aspect = payload.aspect || "9:16";
const globe = payload.globe !== false && stops.some(s => s.mode === "plane");

if (stops.length < 2) {
  console.error("Need at least two stops. Got:", stops.length);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const started = Date.now();
const mins = () => ((Date.now() - started) / 60000).toFixed(1) + "m";

console.log(`Rendering ${stops.length} stops: ${stops.map(s => s.name).join(" → ")}`);
console.log(`  aspect ${aspect}, globe ${globe}, accent ${ACCENT}`);

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

// Pixel count is everything here: with no GPU, every frame is rasterised in
// software, so cost scales directly with canvas area. deviceScaleFactor 2 on
// this viewport meant 2400x3000 = 7.2M pixels/frame and ~5.7s per frame.
// At dsf 1 the stage lands near 1080x1920 — the Instagram target, and the size
// TripTrail would downsample to anyway, so this costs nothing in output
// quality. The sidebar eats ~300px of width, hence the extra.
const context = await browser.newContext({
  viewport: { width: 1420, height: 1960 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
});
const page = await context.newPage();
page.on("console", m => {
  const t = m.text();
  if (m.type() === "error" || /export|encoder|muxer/i.test(t)) console.log(`  [page] ${t}`);
});

await page.goto(BASE, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => typeof map !== "undefined" && map.loaded(), null, { timeout: 90000 });
console.log(`[${mins()}] app loaded`);

// Inject route and settings.
// `route`, not `stops` — a parameter named `stops` would shadow the page's own
// binding and the assignment below would go nowhere.
const injected = await page.evaluate(({ route, title, subtitle, aspect, globe, accent }) => {
  stops = route.map(s => ({ ...s, id: id() }));
  afterStopsChange();

  const set = (sel, val, evt) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.type === "checkbox") el.checked = val; else el.value = val;
    el.dispatchEvent(new Event(evt, { bubbles: true }));
  };
  set("#inp-accent", accent, "input");
  set("#inp-title", title, "input");
  set("#inp-subtitle", subtitle, "input");
  set("#chk-globe", globe, "change");
  set("#sel-aspect", aspect, "change");
  set("#sel-format", "mp4", "change");

  return {
    stops: stops.map(s => `${s.name}/${s.mode}`),
    count: document.querySelector("#stop-count").textContent,
    canvas: (() => { const c = document.querySelector("#map canvas"); return c ? `${c.width}x${c.height}` : "none"; })(),
  };
}, { route: stops, title, subtitle, aspect, globe, accent: ACCENT });

console.log(`[${mins()}] injected ${injected.count} stops: ${injected.stops.join(", ")}`);
console.log(`  render canvas ${injected.canvas} — frame cost scales with this`);
if (String(injected.count) !== String(stops.length)) {
  console.error("Injection did not take — sidebar shows", injected.count);
  process.exit(1);
}

// Record. The offline path steps frames deterministically, so nothing here
// depends on the tab being visible.
const downloadPromise = page.waitForEvent("download", { timeout: 85 * 60 * 1000 });
await page.click("#btn-record");
console.log(`[${mins()}] recording started (prewarming tiles, then encoding)…`);

// Surface progress so a long job doesn't look hung.
const progress = setInterval(async () => {
  try {
    const txt = await page.$eval("#loading-text", el => el.textContent).catch(() => null);
    if (txt) console.log(`[${mins()}] ${txt}`);
  } catch { /* page busy */ }
}, 30000);

await page.waitForSelector("#btn-download:not(.hidden)", { timeout: 85 * 60 * 1000 });
clearInterval(progress);

const label = await page.$eval("#dl-label", el => el.textContent).catch(() => "");
console.log(`[${mins()}] render complete — ${label}`);

await page.click("#btn-download");
const download = await downloadPromise;
const outPath = path.join(OUT_DIR, "route.mp4");
await download.saveAs(outPath);

await browser.close();

const size = fs.statSync(outPath).size;
if (size < 10000) {
  console.error(`Output is only ${size} bytes — render produced nothing usable.`);
  process.exit(1);
}
console.log(`[${mins()}] saved ${outPath} (${(size / 1048576).toFixed(1)} MB)`);
