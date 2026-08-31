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
// Landscape by default. A globe cropped into a portrait frame loses its left
// and right edges and reads as squashed — 16:9 gives the sphere room.
const aspect = payload.aspect || "16:9";
const hasFlight = stops.some(s => s.mode === "plane");
const hasGround = stops.slice(1).some(s => s.mode !== "plane");
const globe = payload.globe !== false && hasFlight;

/**
 * Pace divides every segment duration, so lower is slower. The slider runs
 * 0.4-2.2 and TripTrail labels anything under 0.8 "Cinematic".
 *
 * Keyed on ground legs, not flights. A short drive gets TripTrail's floor of
 * 2200ms however far it goes, so at normal pace it is over in two seconds — and
 * keying on flights meant one flight leg rushed every drive in the same trip.
 * A flight rendered slowly just reads as cinematic, so erring slow is safe.
 */
const pace = payload.pace ?? (hasGround ? 0.4 : 1);

/** Dark Matter by default: satellite is TripTrail's own default and clashes
 *  with the site's dark theme. Any value from its style menu works. */
const STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  eclipse: "https://tiles.versatiles.org/assets/styles/eclipse/style.json",
  voyager: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  positron: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  fiord: "https://tiles.openfreemap.org/styles/fiord",
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  satellite: "satellite",
};
const style = STYLES[payload.style || "dark"] || payload.style || STYLES.dark;

if (stops.length < 2) {
  console.error("Need at least two stops. Got:", stops.length);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const started = Date.now();
const mins = () => ((Date.now() - started) / 60000).toFixed(1) + "m";

console.log(`Rendering ${stops.length} stops: ${stops.map(s => s.name).join(" → ")}`);

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

// The window has to suit the aspect, or layoutStage() fits the stage to the
// wrong dimension and the map ends up far smaller than intended.
//
// Pixel count is everything here: with no GPU every frame is rasterised in
// software, so cost scales with canvas area. deviceScaleFactor 2 once meant
// 7.2M pixels/frame and ~5.7s per frame. At dsf 1 with a 1920 long edge it is
// ~2M either way, so landscape costs no more than portrait did.
const [aspectW, aspectH] = aspect.split(":").map(Number);
const LONG_EDGE = 1920;
const stageW = aspectW >= aspectH ? LONG_EDGE : Math.round((LONG_EDGE * aspectW) / aspectH);
const stageH = aspectW >= aspectH ? Math.round((LONG_EDGE * aspectH) / aspectW) : LONG_EDGE;

const context = await browser.newContext({
  // Sidebar takes ~300px of width; the toolbar and padding ~180px of height.
  viewport: { width: stageW + 340, height: stageH + 200 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
});
console.log(`  aspect ${aspect} (stage ${stageW}x${stageH}), globe ${globe}, accent ${ACCENT}, style ${payload.style || "dark"}, pace ${pace}`);
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
const injected = await page.evaluate(({ route, title, subtitle, aspect, globe, accent, style, pace }) => {
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
  set("#sel-style", style, "change");
  set("#rng-pace", String(pace), "input");
  set("#sel-format", "mp4", "change");

  return {
    stops: stops.map(s => `${s.name}/${s.mode}`),
    count: document.querySelector("#stop-count").textContent,
    canvas: (() => { const c = document.querySelector("#map canvas"); return c ? `${c.width}x${c.height}` : "none"; })(),
    paceLabel: document.querySelector("#pace-val").textContent,
  };
}, { route: stops, title, subtitle, aspect, globe, accent: ACCENT, style, pace });

console.log(`[${mins()}] injected ${injected.count} stops: ${injected.stops.join(", ")}`);
console.log(`  render canvas ${injected.canvas} — frame cost scales with this`);
if (String(injected.count) !== String(stops.length)) {
  console.error("Injection did not take — sidebar shows", injected.count);
  process.exit(1);
}

// Changing the style calls setStyle(..., {diff:false}), which tears the whole
// style down and re-adds the route layers. Recording before that settles would
// capture a half-built basemap.
await page.waitForFunction(() => map.isStyleLoaded() && map.loaded(), null, { timeout: 120000 });
await page.waitForTimeout(3000);
console.log(`[${mins()}] basemap settled`);

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
