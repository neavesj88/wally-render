/**
 * Local modifications to the TripTrail clone (MIT, © 2026 Fangyuan Lin).
 *
 * Each patch asserts its anchor text first, so if upstream changes the build
 * fails loudly instead of silently rendering unpatched.
 */
import fs from "node:fs";

const FILE = process.argv[2] || "triptrail/app.js";
let src = fs.readFileSync(FILE, "utf8");
const applied = [];

function patch(name, find, replace) {
  if (!src.includes(find)) {
    console.error(`PATCH FAILED: "${name}" — anchor not found. Upstream changed; re-check this patch.`);
    process.exit(1);
  }
  src = src.replace(find, replace);
  applied.push(name);
}

/* ---------------------------------------------------------------
 * 1. Per-frame settle cap.
 * Every exported frame waits this long for the map to finish drawing, then
 * copies the canvas regardless. 900ms assumes a GPU; under SwiftShader a frame
 * takes seconds, so it expired every time and grabbed the canvas mid-update —
 * the GL trail lagged the canvas overlay, putting pins and the plane off route.
 * ------------------------------------------------------------- */
patch(
  "frame-settle cap 900ms -> 20s",
  "function mapFrameSettled(maxWaitMs = 900) {",
  "function mapFrameSettled(maxWaitMs = 20000) {",
);

/* ---------------------------------------------------------------
 * 2. Camera path smoothing.
 * The camera centre is sampled straight off the drawn polyline, and
 * trailPointAt interpolates linearly between vertices. A road route from OSRM
 * has a vertex at every bend, so the camera path is piecewise-linear with a
 * hard corner at each one — visible as jerk when zoomed in. A plane leg is a
 * smooth great circle, which is why it only shows on roads.
 *
 * Smooth a separate copy of the coordinates for the camera only. The trail
 * itself keeps tracing the road exactly, so nothing about the drawn route
 * changes — only what the camera follows.
 * ------------------------------------------------------------- */
patch(
  "add smoothed camera path helpers",
  "/* ============================================================ tile prewarm */",
  `/* ---- camera path smoothing (local patch) ---- */

// Three passes of a moderate window rather than one wide one. Repeated box
// filtering approximates a Gaussian, which flattens the *rate of turn* — what
// reads as jerk — much more than it displaces the path itself. One wide window
// would soften just as much but cut corners off switchbacks, dragging the
// camera away from the road and pushing the marker toward the frame edge.
// Endpoints stay anchored so the camera still arrives exactly at each stop.
function smoothCoords(coords) {
  const n = coords.length;
  if (n < 5) return coords.map(c => c.slice());
  const half = Math.max(2, Math.min(24, Math.round(n / 40)));
  let cur = coords.map(c => c.slice());
  for (let pass = 0; pass < 3; pass++) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
      let sx = 0, sy = 0;
      for (let j = lo; j <= hi; j++) { sx += cur[j][0]; sy += cur[j][1]; }
      const count = hi - lo + 1;
      out.push([sx / count, sy / count]);
    }
    out[0] = coords[0].slice();
    out[n - 1] = coords[n - 1].slice();
    cur = out;
  }
  return cur;
}

// Each leg is smoothed on its own. decimate() gives every leg the same point
// budget regardless of length, so spacing can change 150-fold at a junction —
// a drive at 40m per point meeting a flight at 6km per point. One window across
// the join averages those together and the camera lurches at the handover.
function smoothPerLeg(coords, legStart, legLen) {
  const out = coords.map(c => c.slice());
  for (let k = 0; k < legStart.length; k++) {
    const from = legStart[k], len = legLen[k];
    const seg = smoothCoords(coords.slice(from, from + len));
    for (let i = 0; i < len; i++) out[from + i] = seg[i];
  }
  return out;
}

// Mirrors trailPointAt but reads the smoothed array. Shares anim.mcum, which is
// valid because camCoords is index-aligned with fullCoords.
function camPointAt(frac) {
  if (!anim.camCoords || anim.camCoords.length !== anim.fullCoords.length) return trailPointAt(frac);
  const cum = anim.mcum, d = clamp(frac, 0, 1) * anim.mtotal;
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
  const seg = cum[lo] - cum[lo - 1] || 1, t = (d - cum[lo - 1]) / seg;
  const a = anim.camCoords[lo - 1], b = anim.camCoords[lo];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/* ============================================================ tile prewarm */`,
);

patch(
  "build the smoothed path alongside fullCoords",
  `  anim.mcum = mcum;
  anim.mtotal = mcum[mcum.length - 1] || 1;`,
  `  anim.mcum = mcum;
  anim.mtotal = mcum[mcum.length - 1] || 1;
  anim.camCoords = smoothPerLeg(anim.fullCoords, legStart, legLen);   // local patch: camera only`,
);

patch(
  "camera follows the smoothed path",
  "    const lead = trailPointAt(clamp(frac + 0.2 * wave * span, 0, 1));",
  "    const lead = camPointAt(clamp(frac + 0.2 * wave * span, 0, 1));",
);


/* ---------------------------------------------------------------
 * 3. Leg transition and ground-leg duration.
 *
 * Each leg's zoom comes from cameraForBounds of that leg alone, so a 25km drive
 * sits near zoom 10 and a 3900km flight near zoom 3. The approach segment that
 * moves between them is clamped to 950ms, ramming a seven-level zoom change
 * through in under a second — and the pace slider cannot lengthen it because
 * the clamp caps the result. Scale it with the size of the change instead.
 *
 * Separately, a leg's travel time is clamp(2200 + km*1.1, 2200, 7000), so every
 * drive under ~450km lands on the 2200ms floor no matter how slow the pace. A
 * higher floor for ground legs is the only way to give them room.
 * ------------------------------------------------------------- */
patch(
  "scale the approach to the zoom change",
  "    add('approach', clamp(750 / p, 350, 950), { a: prevCam, b: startCam, caption, reached: i + 1 });",
  `    const dz = Math.abs((startCam.zoom || 0) - (prevCam.zoom || 0));   // local patch
    add('approach', clamp((750 + dz * 250) / p, 350, 4000), { a: prevCam, b: startCam, caption, reached: i + 1 });`,
);

patch(
  "give ground legs a longer floor",
  "    add('travel', clamp(2200 + leg.dist * 1.1, 2200, 7000) / p, { leg: i, caption, pitchCruise, pitchMax, reached: i + 1 });",
  `    // local patch: a short drive otherwise sits on the 2200ms floor whatever
    // the pace, which is why ground legs still felt rushed at the slider's end.
    const floorMs = leg.modeKey === 'plane' ? 2200 : 4000;
    add('travel', clamp(floorMs + leg.dist * 1.1, floorMs, 7000) / p, { leg: i, caption, pitchCruise, pitchMax, reached: i + 1 });`,
);

fs.writeFileSync(FILE, src);
console.log(`Patched ${FILE}:`);
for (const a of applied) console.log(`  - ${a}`);
