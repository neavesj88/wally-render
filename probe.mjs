/**
 * Does a GPU-less CI runner have everything TripTrail's offline export needs?
 *
 * Its renderOffline() path silently falls back to realtime MediaRecorder
 * capture — which requires a live, visible tab — unless ALL of these hold:
 *   1. WebGL works (MapLibre renders through it; no GPU here, so SwiftShader)
 *   2. VideoEncoder exists and one of its four H.264 profiles is supported
 *   3. That encoder actually emits chunks, not just claims support
 *   4. mp4-muxer loads from the CDN
 * isConfigSupported() alone is not proof, so step 3 encodes real frames.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", m => { if (m.type() === "error") console.log("  page error:", m.text()); });

// Load the real app: same origin as the render would use, and it proves
// MapLibre itself survives software rendering.
await page.goto("https://travel-map-animator.vercel.app/", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(6000);

const result = await page.evaluate(async () => {
  const out = { steps: {} };

  // --- 1. WebGL under software rendering ---
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  out.steps.webgl = !!gl;
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
    out.glVersion = gl.getParameter(gl.VERSION);
  }

  // --- MapLibre actually painted something? ---
  try {
    out.steps.mapLoaded = typeof map !== "undefined" && map.loaded();
    const mc = document.querySelector("#map canvas");
    out.mapCanvas = mc ? `${mc.width}x${mc.height}` : "none";
  } catch (e) { out.steps.mapLoaded = "error: " + e.message; }

  // --- 2. WebCodecs H.264 config support ---
  out.steps.videoEncoderExists = typeof VideoEncoder !== "undefined";
  if (!out.steps.videoEncoderExists) return out;

  out.configs = {};
  let working = null;
  // Same four profiles renderOffline() tries, in its order, at a 9:16 size.
  for (const codec of ["avc1.64002A", "avc1.640028", "avc1.4D0028", "avc1.42E01F"]) {
    try {
      const cfg = { codec, width: 1080, height: 1920, bitrate: 8_000_000, framerate: 30 };
      const s = await VideoEncoder.isConfigSupported(cfg);
      out.configs[codec] = !!s.supported;
      if (s.supported && !working) working = cfg;
    } catch (e) {
      out.configs[codec] = "error: " + e.message;
    }
  }
  out.steps.anyConfigSupported = !!working;
  if (!working) return out;
  out.chosenCodec = working.codec;

  // --- 3. Prove it encodes: claimed support is not delivered bytes ---
  try {
    const src = document.createElement("canvas");
    src.width = working.width; src.height = working.height;
    const ctx = src.getContext("2d");
    let chunks = 0, bytes = 0, encErr = null;

    const enc = new VideoEncoder({
      output: c => { chunks++; bytes += c.byteLength; },
      error: e => { encErr = e.message; },
    });
    enc.configure(working);

    for (let i = 0; i < 20; i++) {
      ctx.fillStyle = `hsl(${i * 18}, 80%, 50%)`;
      ctx.fillRect(0, 0, src.width, src.height);
      const vf = new VideoFrame(src, { timestamp: i * 33333, duration: 33333 });
      enc.encode(vf, { keyFrame: i === 0 });
      vf.close();
    }
    await enc.flush();
    enc.close();

    out.steps.actuallyEncoded = chunks > 0 && !encErr;
    out.encodedChunks = chunks;
    out.encodedBytes = bytes;
    if (encErr) out.encodeError = encErr;
  } catch (e) {
    out.steps.actuallyEncoded = false;
    out.encodeError = e.message;
  }

  // --- 4. The muxer that turns those chunks into an .mp4 ---
  try {
    const mux = await import("https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm");
    out.steps.muxerLoaded = typeof mux.Muxer === "function";
  } catch (e) {
    out.steps.muxerLoaded = false;
    out.muxerError = e.message;
  }

  return out;
});

await browser.close();

console.log("\n=== TripTrail headless render probe (ubuntu-latest, no GPU) ===\n");
console.log(JSON.stringify(result, null, 2));

const required = ["webgl", "mapLoaded", "videoEncoderExists", "anyConfigSupported", "actuallyEncoded", "muxerLoaded"];
const failed = required.filter(k => result.steps[k] !== true);

console.log("\n" + "=".repeat(62));
if (failed.length === 0) {
  console.log("VERDICT: PASS — offline export is viable headless. No live tab needed.");
} else {
  console.log("VERDICT: FAIL — falls back to realtime capture, which needs a live tab.");
  console.log("Failed: " + failed.join(", "));
}
console.log("=".repeat(62));

process.exit(failed.length === 0 ? 0 : 1);
