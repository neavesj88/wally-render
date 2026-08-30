# wally-render

Renders TripTrail route animations for [neaves.au](https://neaves.au) on GitHub's
runners, so neither the phone nor the 1GB web server has to do it.

## Why this works

TripTrail's `renderOffline()` steps frames deterministically (`paintFrame(t)` +
`mapFrameSettled()`) rather than driving off `requestAnimationFrame`, so it does
not need a live, visible tab — the usual blocker for headless video capture.
It only takes that path if WebCodecs can encode H.264, which was verified on
`ubuntu-latest` with no GPU: three of four profiles supported, real chunks
emitted. See `probe.mjs`.

## Running one

Actions → **Render travel animation** → Run workflow, with a route like:

```json
{"title":"Perth to Munich","aspect":"16:9","stops":[
  {"name":"Perth","lng":115.8613,"lat":-31.9523,"mode":"plane"},
  {"name":"Dubai","lng":55.2708,"lat":25.2048,"mode":"plane"},
  {"name":"München","lng":11.582,"lat":48.1351,"mode":"plane"}]}
```

The Wally editor's **Copy render payload** button produces this.

`mode` is how you *arrived* at that stop, so the first one's is ignored.
Globe view turns on automatically when any leg is a flight.

## Publishing

Add a repository secret  matching the server's, and the clip
uploads itself to . Pass  to attach it to a
travel post. Without the secret the render still runs and the clip is an artifact.

That endpoint exists because Cloudflare's managed challenge blocks
 from datacenter IPs — correctly, since that is the brute-force
surface. A WAF skip rule is scoped to this one path, and the token can do
nothing except attach a video.

## Third-party code

[TripTrail](https://github.com/Fangyuan025/triptrail) is MIT, © 2026 Fangyuan Lin.
It is cloned at render time and served locally — the author's own deployment is
never automated against.
