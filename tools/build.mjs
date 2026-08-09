// Rewrites the mirrored site to use the optimized media:
//   1. swaps module 50431 (hero video player) for tools/player-module.js
//   2. repoints every image reference at its hashed /media/i/ variant
//   3. drops the original media trees
//   4. emits _headers (immutable caching) and the format-negotiating middleware
import { readFile, writeFile, readdir, rm, mkdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const CHUNKS = path.join(SITE, "_next", "static", "chunks");

const videoManifest = JSON.parse(await readFile(path.join(ROOT, "video-manifest.json"), "utf8"));
const imageManifest = JSON.parse(await readFile(path.join(ROOT, "image-manifest.json"), "utf8"));

// ---- 1. player module ------------------------------------------------------
// Keyed by the ORIGINAL public path: those string literals stay in the page
// chunks and now act purely as identifiers the player resolves through here.
const playerMap = {};
let av1Kept = 0;
let av1Dropped = 0;
for (const v of videoManifest) {
  // The H.264 renditions are bitrate-capped and the AV1 ones are pure CRF, so
  // AV1 lands smaller on some clips and larger on others. Only offer it where
  // it actually wins; otherwise the "modern codec" path costs bytes.
  const av1 = (alt, h264) => {
    if (!alt) return null;
    if (alt.bytes >= h264.bytes) {
      av1Dropped++;
      return null;
    }
    av1Kept++;
    return alt.url;
  };
  const dAv1 = av1(v.desktopAv1, v.desktop);
  const mAv1 = av1(v.mobileAv1, v.mobile);

  // Posters are hashed per file, so the .avif sibling would not share the .jpg
  // stem the middleware substitutes into. Realign it here.
  let posterUrl = v.posterJpg.url;
  if (v.posterAvif) {
    const want = posterUrl.replace(/\.jpg$/, ".avif");
    const from = path.join(SITE, v.posterAvif.url.slice(1));
    const to = path.join(SITE, want.slice(1));
    if (v.posterAvif.url !== want && existsSync(from)) await rename(from, to);
    if (existsSync(to)) v.posterAvif.url = want;
  }

  // A ~24px blurred thumbnail, inlined as a data URI. The poster is still a
  // real ~160KB request, so on a throttled link the hero was black until it
  // landed. This costs no request and paints with the first frame of HTML.
  const lqipBuf = await sharp(path.join(SITE, posterUrl.slice(1)))
    .resize({ width: 24 })
    .blur(1.2)
    .jpeg({ quality: 40 })
    .toBuffer();
  const lqip = `data:image/jpeg;base64,${lqipBuf.toString("base64")}`;

  playerMap[v.original] = {
    lqip,
    poster: posterUrl,
    desktop: v.desktop.url,
    mobile: v.mobile.url,
    ...(v.high ? { high: v.high.url } : {}),
    ...(dAv1 ? { desktopAv1: dAv1 } : {}),
    ...(mAv1 ? { mobileAv1: mAv1 } : {}),
  };
}
console.log(`AV1 renditions: ${av1Kept} kept (smaller), ${av1Dropped} dropped (not smaller)`);

// Any AV1 file we are not serving is dead weight in the deploy.
const referenced = new Set(
  Object.values(playerMap).flatMap((m) => [m.poster, m.desktop, m.mobile, m.high, m.desktopAv1, m.mobileAv1].filter(Boolean)),
);
for (const v of videoManifest) {
  if (v.posterAvif) referenced.add(v.posterAvif.url);
  for (const alt of [v.desktopAv1, v.mobileAv1]) {
    if (alt && !referenced.has(alt.url)) await rm(path.join(SITE, alt.url.slice(1)), { force: true });
  }
}

let playerSrc = await readFile(path.join(ROOT, "tools", "player-module.js"), "utf8");
playerSrc = playerSrc
  .replace(/^\/\/.*$/gm, "")            // strip the header comment block
  .replace("__VIDEO_MANIFEST__", JSON.stringify(playerMap))
  .trim();

const MODULE_START = "50431,e=>{";
// Turbopack lays modules out as `},<id>,e=>{`; that boundary marks our end.
const NEXT_MODULE = /\},\d{3,6},e=>\{/g;

async function patchPlayer(file) {
  const full = path.join(CHUNKS, file);
  let src = await readFile(full, "utf8");
  const start = src.indexOf(MODULE_START);
  if (start === -1) return false;

  NEXT_MODULE.lastIndex = start + MODULE_START.length;
  const m = NEXT_MODULE.exec(src);
  if (!m) throw new Error(`${file}: could not find end of module 50431`);

  const before = src.slice(0, start);
  const after = src.slice(m.index + 1); // keep the `,<id>,e=>{` that follows
  const patched = `${before}50431,${playerSrc}${after}`;
  await writeFile(full, patched);

  // A syntax error here would silently blank the page, so verify every chunk.
  await run("/opt/homebrew/bin/node", ["--check", full]);
  return true;
}

let patchedCount = 0;
for (const f of await readdir(CHUNKS)) {
  if (!f.endsWith(".js")) continue;
  if (await patchPlayer(f)) {
    patchedCount++;
    console.log(`patched player in ${f}`);
  }
}
if (patchedCount === 0) throw new Error("module 50431 not found in any chunk");

// ---- 2. image path rewrite -------------------------------------------------
const ORIGIN = "https://www.andrewwagnerarchitects.com";
const replacements = [];
for (const img of imageManifest) {
  if (img.original === "/favicon.jpg") continue; // tiny, and referenced by <link rel=icon>
  replacements.push([img.original, img.defaultUrl]);
  const enc = encodeURI(img.original);
  if (enc !== img.original) replacements.push([enc, img.defaultUrl]);
  replacements.push([ORIGIN + enc, img.defaultUrl]);
  replacements.push([ORIGIN + img.original, img.defaultUrl]);
}
// Longest-first so an absolute URL is never partially consumed by its own path.
replacements.sort((a, b) => b[0].length - a[0].length);

async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "media") continue;
      await walk(full, acc);
    } else if (/\.(html|js|css|json|xml|txt)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

let rewrites = 0;
const touched = [];
for (const file of await walk(SITE)) {
  const src = await readFile(file, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    rewrites++;
  }
  if (out !== src) {
    await writeFile(file, out);
    touched.push(path.relative(SITE, file));
  }
}
console.log(`\nrewrote ${rewrites} image references across ${touched.length} files`);

// Fail loudly if any original media path survived into shipped markup/JS.
const leftovers = [];
for (const file of await walk(SITE)) {
  const src = await readFile(file, "utf8");
  for (const dir of ["/Landing Page/", "/Commercial Page/", "/Residential Page/", "/Studio Page/"]) {
    // Video paths legitimately remain as manifest keys inside the player.
    const re = new RegExp(dir.replace(/[/]/g, "\\/") + "[^\"']*?\\.(?:jpg|jpeg|png)", "g");
    for (const hit of src.match(re) || []) leftovers.push(`${path.relative(SITE, file)} -> ${hit}`);
  }
}
if (leftovers.length) {
  console.warn(`\n!! ${leftovers.length} unrewritten image refs:`);
  for (const l of leftovers.slice(0, 10)) console.warn(`   ${l}`);
}

// ---- 3. drop the originals -------------------------------------------------
for (const d of ["Landing Page", "Commercial Page", "Residential Page", "Studio Page"]) {
  await rm(path.join(SITE, d), { recursive: true, force: true });
}
await rm(path.join(SITE, "image360_high_quality.jpeg"), { force: true });

// ---- 4. headers + middleware ----------------------------------------------
await writeFile(
  path.join(SITE, "_headers"),
  await readFile(path.join(ROOT, "tools", "headers.template"), "utf8"),
);

// The middleware lives at functions/_middleware.js and is maintained by hand.

// ---- report ----------------------------------------------------------------
async function dirBytes(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(full) : (await stat(full)).size;
  }
  return total;
}
console.log(`\nsite payload now ${((await dirBytes(SITE)) / 1048576).toFixed(1)} MB on disk`);
console.log(`  videos ${((await dirBytes(path.join(SITE, "media", "v"))) / 1048576).toFixed(1)} MB`);
console.log(`  images ${((await dirBytes(path.join(SITE, "media", "i"))) / 1048576).toFixed(1)} MB`);
