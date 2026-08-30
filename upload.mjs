/**
 * Publishes the finished clip to neaves.au.
 *
 * Uses a scoped render token against /api/render/upload-video rather than the
 * admin password against /api/admin/login. Two reasons: Cloudflare's managed
 * challenge blocks /api/admin/* from datacenter IPs (correctly — that is the
 * brute-force surface), and CI should not hold a credential that can do
 * anything beyond attaching a video.
 *
 * Skips cleanly when no token is set, leaving the CI artifact to collect by hand.
 */
import fs from "node:fs";

const SITE = process.env.SITE_URL || "https://neaves.au";
const TOKEN = process.env.RENDER_TOKEN;
const FILE = process.env.VIDEO_PATH || "out/route.mp4";
const POST_ID = process.env.POST_ID || "";

if (!TOKEN) {
  console.log("RENDER_TOKEN not set — skipping upload.");
  console.log("Download the clip from this run's artifacts instead.");
  process.exit(0);
}
if (!fs.existsSync(FILE)) {
  console.error(`No video at ${FILE}`);
  process.exit(1);
}

const form = new FormData();
form.append("video", new Blob([fs.readFileSync(FILE)], { type: "video/mp4" }), "route.mp4");
if (POST_ID) form.append("postId", POST_ID);

const res = await fetch(`${SITE}/api/render/upload-video`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});

const body = await res.text();
if (!res.ok) {
  // A Cloudflare challenge comes back as an HTML page, not JSON — say so plainly
  // rather than dumping the whole interstitial into the log.
  if (body.includes("Just a moment") || body.includes("cf_chl_opt")) {
    console.error(`Blocked by Cloudflare (${res.status}). The WAF skip rule for`);
    console.error("/api/render/upload-video is missing or not matching.");
  } else {
    console.error(`Upload failed: ${res.status} ${body.slice(0, 300)}`);
  }
  process.exit(1);
}

const out = JSON.parse(body);
console.log(`Uploaded: ${SITE}${out.videoUrl}`);
console.log(out.attached ? `Attached to post ${out.postId}.` : "Not attached — no post id given.");
