# andrewwagner — performance-optimized mirror

Tooling that mirrors [andrewwagnerarchitects.com](https://www.andrewwagnerarchitects.com),
rebuilds its media, patches the shipped bundle, and deploys the result to
Cloudflare Pages.

## 🔗 Live site

### **https://awa-optimized.pages.dev**

Served from Cloudflare Pages. Sent as `noindex, nofollow` with
`robots.txt: Disallow: /` — this is a performance demo, not a production site,
and must not compete with the real one in search. The contact form is
deliberately disconnected (see below).

This repo contains **only the build tooling**. The mirrored site and its media
are regenerated from the origin and are gitignored — no third-party imagery or
video is stored here.

## Where the files actually live

Media is split across two backends, but both are served from the **same
`/media/` URL space**, so nothing in the markup knows the difference.

| Path | Backend | Why |
|---|---|---|
| `/media/i/*` | Pages assets | Images; all well under the size limit |
| `/media/v/*-1080.*`, `*-720.*`, `*-poster.*` | Pages assets | Capped renditions and posters |
| `/media/v/*-high.*.mp4` | **R2** (`awa-media`) | Full-quality video; three clips exceed the 25 MiB Pages asset limit |

The R2 bucket has **no public `r2.dev` URL**. Objects are reached only through
`functions/_middleware.js`, which reads them from the `MEDIA` binding declared
in `wrangler.toml`. That keeps them behind the CDN, lets them inherit the
`immutable` cache header, and supports `Range` requests — Safari will not begin
playback without them.

### URL pattern

```
/media/v/<slug>-<tier>.<hash8>.<ext>
/media/i/<slug>.<hash8>.w<width>.<ext>
```

`<hash8>` is the first 8 hex of the SHA-256 of the file's own bytes, which is
what makes `max-age=31536000, immutable` safe. Images hash the *source* so the
middleware can derive sibling variants by string substitution alone.

### Live examples — one clip, every tier

Horseshoe Bay / Live Oak Pavilion, 49 s, 34.9 MB as delivered by the origin:

| Tier | Size | URL |
|---|---|---|
| **high** (R2, lossless) | 34.8 MB | [`…-high.bd4e766a.mp4`](https://awa-optimized.pages.dev/media/v/commercial-1-horseshoe-bay-resort-live-oak-pavilion-texas-hill-high.bd4e766a.mp4) |
| desktop (capped 1080p) | 11.8 MB | [`…-1080.8772b885.mp4`](https://awa-optimized.pages.dev/media/v/commercial-1-horseshoe-bay-resort-live-oak-pavilion-texas-hill-1080.8772b885.mp4) |
| mobile (720p) | 5.8 MB | [`…-720.c10d7495.mp4`](https://awa-optimized.pages.dev/media/v/commercial-1-horseshoe-bay-resort-live-oak-pavilion-texas-hill-720.c10d7495.mp4) |
| poster | 168 KB | [`…-poster.510ab934.jpg`](https://awa-optimized.pages.dev/media/v/commercial-1-horseshoe-bay-resort-live-oak-pavilion-texas-hill-poster.510ab934.jpg) |

The poster URL ends in `.jpg` but returns **AVIF** (~100 KB) to any browser
that sends `Accept: image/avif`. Same for every image under `/media/i/`:

```bash
# 244 KB JPEG                                    -> 112 KB AVIF
curl -H 'Accept: image/avif' -I \
  https://awa-optimized.pages.dev/media/i/studio-horseshoe-bay.718883ae.w2048.jpg

# Range requests against the R2-backed tier
curl -r 0-1023 -D - -o /dev/null \
  https://awa-optimized.pages.dev/media/v/commercial-1-horseshoe-bay-resort-live-oak-pavilion-texas-hill-high.bd4e766a.mp4
# -> HTTP/2 206, content-range: bytes 0-1023/36508961
```

The full list of R2-hosted objects is the `high` entry of each record in
[`video-manifest.json`](video-manifest.json).

## Why

A profile of the live site found the sluggishness was entirely media payload —
no long tasks, no dropped frames, TTFB 209 ms. Across all four pages the site
ships **280.7 MB** of media, including a 51 MB video and a 10.8 MB
(10707×5370) JPEG.

| | Before | Desktop | Mobile |
|---|---|---|---|
| Video (8 files) | 189.0 MB | 62.2 MB capped / 189 MB lossless | 29.5 MB |
| Images (109 files) | 91.6 MB | 14.8 MB | 7.2 MB |

## Usage

```bash
npm install
./deploy.sh                      # rebuild + publish
node tools/build-all.mjs         # rebuild only
node tools/build-all.mjs --media # also re-download and re-encode all media (~20 min)
node tools/build-all.mjs --trim=12  # short hero loops (implies --media)
```

Requires `ffmpeg` on PATH and a `wrangler login` with access to the target
Cloudflare account.

## What it does

**Video** — see [the detailed section below](#video-optimization-in-detail).

**Images** — two widths × AVIF/WebP/JPEG. Equirectangular panoramas are
detected and given 4096 px in the widest slot, since a 360 viewer shows only
~90° at a time.

**Bundle** — the hero player (Turbopack module `50431`) is replaced wholesale.
The original set a single `src` with no poster and faded in from `opacity-0`,
which is why the hero was a black box until the file buffered. The replacement
adds a poster, a ~540-byte inlined blurred frame, per-tier selection, `muted`
set on the node before `play()`, `preload="none"` with the fetch deferred past
first paint, and IntersectionObserver gating.

**Delivery** — a Pages Function negotiates AVIF/WebP off `Accept`, drops to the
narrow rendition on `Save-Data` or a small viewport hint, proxies the R2 tier
with full `Range` support, and stubs `/api/contact`.

## Video optimization in detail

Eight clips, 189 MB, every one 1920×1080. Source bitrates ran 2,000–7,700 kbps
for footage that is mostly slow drone pans — the spread alone said the encodes
were never tuned. The reference point for "how much is enough" came from the
site itself: the 2,068 kbps clip looked indistinguishable from the 5,900 kbps
one, so ~2,000 kbps became the target rather than a guess.

### Four tiers, chosen at runtime

| Tier | Encode | Size | Served when |
|---|---|---|---|
| `high` | `-c:v copy` (remux only) | 189 MB | Wide viewport + unconstrained link |
| `desktop` | x264 CRF 27, `maxrate 2000k` | 62.2 MB | Wide viewport, slow/metered link |
| `mobile` | x264 CRF 29 @1280, `maxrate 1000k` | 29.5 MB | ≤768 px |
| poster only | single frame, AVIF/JPEG | ~148 KB | `Save-Data`, 2g, or `prefers-reduced-motion` |

Selection happens in JS, not markup, because **`<source media="…">` is ignored
inside `<video>`** — it works in `<picture>` only, and relying on it would ship
1080p to every phone. `tools/player-module.js` reads `matchMedia` for the
breakpoint and `navigator.connection` (`saveData`, `effectiveType`, `downlink`)
for the link. Safari and Firefox expose no `navigator.connection`, so absence
is treated as fast — a desktop browser is overwhelmingly the likely case, and
the capped tier is the fallback if that's wrong.

### The lossless tier

`high` is not an encode. It is `ffmpeg -c:v copy`, so the video stream is
bit-for-bit what the architect's editor exported — zero generational loss —
while the container is still repaired:

```bash
ffmpeg -i input.mp4 -c:v copy -an -sn -dn -movflags +faststart out.mp4
```

This is why the tier lives in R2. Pages rejects assets over 25 MiB and three
clips are 28, 35, and 51 MB, so full quality was not merely undesirable on
Pages — it was impossible.

### The capped tiers

```bash
# desktop: 1080p, hard ceiling at 2,000 kbps
ffmpeg -i input.mp4 -an -sn -dn \
  -c:v libx264 -profile:v high -preset slow -crf 27 \
  -maxrate 2000k -bufsize 4000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -vf "hqdn3d=2:1:3:3,scale='min(1920,iw)':-2,fps=30" \
  -pix_fmt yuv420p -movflags +faststart desktop.mp4

# mobile: 720p, original framing preserved
ffmpeg -i input.mp4 -an -sn -dn \
  -c:v libx264 -profile:v high -preset medium -crf 29 \
  -maxrate 1000k -bufsize 2000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -vf "hqdn3d=2:1:3:3,scale='min(1280,iw)':-2,fps=30" \
  -pix_fmt yuv420p -movflags +faststart mobile.mp4
```

Why each flag earns its place:

- **`-maxrate` does the real work, not `-crf`.** CRF alone let the complex
  drone shots run to 5,800 kbps. The cap is what forces the 66% cut; CRF just
  keeps the simpler clips from wasting bits they don't need.
- **`-an`** — one file still carried an AAC track on a permanently muted
  background video: wasted bytes and a second decoder.
- **`fps=30`** — one source was 60 fps, doubling decode cost for motion nobody
  perceives behind text.
- **`hqdn3d=2:1:3:3`** — a light denoise before encoding, so bitrate isn't
  spent preserving sensor grain. Deliberately gentler than ffmpeg's default
  (`4:3:6:4.5`), which would smooth the stone and timber texture that is
  the entire point of the photography.
- **`+faststart`** — two source files had the `moov` atom at the *end*, so the
  browser had to download the whole file before the first frame. A classic and
  invisible cause of "the video takes forever to start."
- **`-g 60 -sc_threshold 0`** — fixed 2-second keyframe interval, so seeking
  and looping land predictably.
- **`scale='min(1920,iw)':-2`** — never upscale; `-2` keeps dimensions even,
  which yuv420p requires.

Mobile is **not** cropped to portrait. Cropping would cut real pixels out of a
composed architectural frame — a design decision, not a compression one — so
the 720p tier keeps the original framing at a quarter of the pixels.

### AV1: generated, then mostly discarded

SVT-AV1 siblings are produced for the capped tiers, but the build **only
references them where they actually come out smaller**, and deletes the rest:

```bash
ffmpeg -i input.mp4 -an -c:v libsvtav1 -preset 7 -crf 46 \
  -svtav1-params tune=0:enable-overlays=1 -g 60 \
  -vf "hqdn3d=2:1:3:3,scale='min(1920,iw)':-2,fps=30" desktop.webm
```

AV1 won on only **4 of 8** clips. At CRF 34 it produced files *larger* than the
capped H.264 (26 MB vs 18 MB on the hero) — the comparison was never
like-for-like, since H.264 was bitrate-capped and AV1 was pure CRF. SVT-AV1's
CRF scale also sits far below x264's at the same number. Serving AV1
unconditionally would have made the "modern codec" path cost bytes.

Where AV1 *is* served, the exact codec string is declared:

```js
probe.canPlayType('video/webm; codecs="av01.0.08M.08"') === "probably"
```

A browser that supports the WebM container but not AV1 would otherwise accept
the file and then fail to decode it.

### Playback, which mattered as much as bytes

The original player set a single `src`, had no `poster`, and faded in from
`opacity-0` — so the hero was a **black rectangle** until enough of a 35 MB
file had buffered. The replacement:

- **`poster`** so the first frame paints without waiting on video.
- **A ~540-byte blurred frame inlined as a `data:` URI** behind the poster.
  The poster is itself a ~148 KB request; on a degraded link (a VPN breaking
  HTTP/3 was how this surfaced) that gap was still black. The inline frame
  costs zero requests and paints with the first byte of HTML.
- **`muted` set on the node in the ref callback**, before any `play()`, in
  addition to the JSX prop — React does not reliably emit the attribute, and
  iOS blocks autoplay without it.
- **`preload="none"`**, with playback started one `requestAnimationFrame` after
  first paint so the video stops racing the page's images for bandwidth.
- **`IntersectionObserver`** — offscreen heroes never fetch at all, and pause
  when scrolled away.
- **A static poster and no video download** on `Save-Data`, 2g, or
  `prefers-reduced-motion: reduce`.

### What was deliberately not done

**No trimming.** The obvious advice for a 49-second background loop is to cut
it to 10–15 seconds. Bitrate turned out to be the actual defect, and cutting an
architectural film is an editorial decision about someone's portfolio, not a
compression one. `--trim=12` is there if the owner wants it.

**Not Cloudflare Stream.** It would add genuine adaptive bitrate — renegotiating
mid-playback instead of guessing once at load — which is a strictly better
answer to "wifi or not" than `navigator.connection`. It needs a paid
subscription and a Stream-scoped API token, and costs ~$5/month for these
4.6 minutes of footage.

## Gotchas

- **`tools/build.mjs` is not idempotent.** It locates the player by the literal
  string `50431,e=>{`, which its own output no longer matches. Always run it
  against a freshly mirrored bundle — `build-all.mjs` re-mirrors first.
- **`fetch-rsc.mjs` must run last.** RSC flight payloads embed chunk filenames.
  Stale ones make Next request URLs that don't exist; Pages answers with the
  HTML fallback and a `200`, so it looks fine from curl and only surfaces as
  Chrome's `MIME type ('text/html') is not executable` plus a silently
  non-hydrating page. `build-all.mjs` ends with a guard that cross-checks every
  referenced chunk against disk and fails the build rather than deploying.
- **Don't rename the chunks.** Re-hashing them to restore content-addressing
  breaks the Turbopack registry. `/_next/static/*` therefore revalidates rather
  than being `immutable`; `/media/*` stays immutable.
- **`<source media>` is ignored inside `<video>`.** It works in `<picture>`
  only. Tier selection has to happen in JS.
- **AV1 is not automatically smaller.** Uncapped SVT-AV1 came out larger than
  bitrate-capped H.264 on half the clips; the build only references it where it
  actually wins.

## Not done

Videos are **not trimmed** — bitrate was the actual problem, and cutting a 49 s
architectural film is an editorial decision. `next/image` `srcset` is off:
flipping its `unoptimized` flag kills hydration silently. Cloudflare Stream
would add true adaptive bitrate but needs a paid subscription and a
Stream-scoped token.
