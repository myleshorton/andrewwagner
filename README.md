# andrewwagner — performance-optimized mirror

Tooling that mirrors [andrewwagnerarchitects.com](https://www.andrewwagnerarchitects.com),
rebuilds its media, patches the shipped bundle, and deploys the result to
Cloudflare Pages.

Live: **https://awa-optimized.pages.dev** (`noindex`, not a production site)

This repo contains **only the build tooling**. The mirrored site and its media
are regenerated from the origin and are gitignored — no third-party imagery or
video is stored here.

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

**Video** — four tiers per clip. `high` is the original stream remuxed with
`-c:v copy` (zero generational loss) and lives in R2, because three clips
exceed the 25 MiB Cloudflare Pages asset limit. `desktop` is 1080p capped at
2,000 kbps, `mobile` is 720p at 1,000 kbps, and constrained clients get a
poster and no video at all. Every encode strips audio, caps at 30 fps, applies
a light `hqdn3d` denoise, and writes `+faststart` — two source files had the
`moov` atom at the end, forcing a full download before the first frame.

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
