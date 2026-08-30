/**
 * Pushes the finished clip to neaves.au.
 *
 * Admin tokens are 2h JWTs, so a stored token would be stale by the next run —
 * the password is the secret, and this trades it for a token per render.
 * Skips cleanly when no secret is configured, leaving the CI artifact as the
 * way to collect the video by hand.
 */
import fs from "node:fs";

const SITE = process.env.SITE_URL || "https://neaves.au";
const PASSWORD = process.env.NEAVES_ADMIN_PASSWORD;
const FILE = process.env.VIDEO_PATH || "out/route.mp4";
const POST_ID = process.env.POST_ID || "";

if (!PASSWORD) {
  console.log("NEAVES_ADMIN_PASSWORD not set — skipping upload.");
  console.log("Download the clip from this run's artifacts instead.");
  process.exit(0);
}
if (!fs.existsSync(FILE)) {
  console.error(`No video at ${FILE}`);
  process.exit(1);
}

const login = await fetch(`${SITE}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!login.ok) {
  console.error(`Login failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
const { token } = await login.json();
if (!token) { console.error("Login returned no token"); process.exit(1); }
console.log("Authenticated.");

const form = new FormData();
form.append("video", new Blob([fs.readFileSync(FILE)], { type: "video/mp4" }), "route.mp4");

const up = await fetch(`${SITE}/api/admin/travel/upload-video`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
if (!up.ok) {
  console.error(`Upload failed: ${up.status} ${await up.text()}`);
  process.exit(1);
}
const { videoUrl } = await up.json();
console.log(`Uploaded: ${SITE}${videoUrl}`);

// Attach it to the post that asked for this render, when one was named.
if (POST_ID) {
  // PUT, not PATCH — the route validates with insertTravelPostSchema.partial(),
  // so a single-field body is accepted.
  const patch = await fetch(`${SITE}/api/admin/travel/posts/${POST_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ videoUrl }),
  });
  console.log(patch.ok
    ? `Attached to post ${POST_ID}.`
    : `Uploaded, but attaching to post ${POST_ID} failed: ${patch.status}`);
}
