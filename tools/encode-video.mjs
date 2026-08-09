// Re-encodes every source video into desktop + mobile H.264 renditions plus
// AVIF/JPEG posters, writes content-hashed files to site/media/v/, and emits
// video-manifest.json mapping the original public path -> optimized set.
//
// Source clips run 2,000-7,700 kbps with one stray AAC track. Targets below cap
// desktop near the 2,000 kbps rendition the profile confirmed already looks fine.
import { mkdir, writeFile, readFile, rm, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";

const run = promisify(execFile);
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.join(SITE, "media", "v");
const TMP = path.join(ROOT, ".tmp-video");

// Trim background loops to this many seconds. null = keep full length, which
// preserves the portfolio edit; set TRIM_SECONDS=12 to opt into short loops.
const TRIM = process.env.TRIM_SECONDS ? Number(process.env.TRIM_SECONDS) : null;

function slugify(p) {
  const base = path.basename(p, path.extname(p));
  const section = p.split("/")[1].replace(/ Page$/, "").toLowerCase();
  const s = base
    .toLowerCase()
    .replace(/andrew wagner architects?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
    .replace(/-+$/, "");
  return `${section}-${s}`.replace(/-+/g, "-");
}

const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

async function findVideos(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "media" || e.name === "_next") continue;
      await findVideos(full, acc);
    } else if (/\.(mp4|mov|webm)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

// Publish a finished encode under a content-hashed name.
async function publish(tmpFile, slug, label, ext) {
  const buf = await readFile(tmpFile);
  const name = `${slug}-${label}.${hash8(buf)}.${ext}`;
  await rename(tmpFile, path.join(OUT, name));
  return { url: `/media/v/${name}`, bytes: buf.length };
}

const trimArgs = TRIM ? ["-t", String(TRIM)] : [];

async function encode(srcAbs) {
  const rel = "/" + path.relative(SITE, srcAbs).split(path.sep).join("/");
  const slug = slugify(rel);
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration,size:stream=width,height",
    "-of", "json", srcAbs,
  ]);
  const meta = JSON.parse(stdout);
  const srcBytes = Number(meta.format.size);
  const duration = Number(meta.format.duration);

  const common = ["-an", "-sn", "-dn", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  // hqdn3d strips sensor grain the encoder would otherwise spend real bitrate
  // preserving; fps caps the one 60fps source, which doubles decode for free.
  const vf = (w) => `hqdn3d=2:1:3:3,scale='min(${w},iw)':-2,fps=30`;

  // Desktop: full 1080p, CRF-driven with a hard ceiling so the 7,700 kbps
  // sources cannot blow past the bitrate the design actually needs.
  const dTmp = path.join(TMP, `${slug}-desktop.mp4`);
  await run(FFMPEG, [
    "-y", "-i", srcAbs, ...trimArgs, ...common,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "27",
    "-maxrate", "2000k", "-bufsize", "4000k",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-vf", vf(1920), dTmp,
  ], { maxBuffer: 1 << 28 });

  // Mobile: 720p keeps the original framing (no portrait crop) so the
  // composition the architect chose survives, at a quarter of the pixels.
  const mTmp = path.join(TMP, `${slug}-mobile.mp4`);
  await run(FFMPEG, [
    "-y", "-i", srcAbs, ...trimArgs, ...common,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "29",
    "-maxrate", "1000k", "-bufsize", "2000k",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-vf", vf(1280), mTmp,
  ], { maxBuffer: 1 << 28 });

  // AV1 siblings. Offered first in the <source> list; browsers that cannot
  // decode av01 fall through to the H.264 files above.
  const dAv1 = path.join(TMP, `${slug}-desktop.webm`);
  const mAv1 = path.join(TMP, `${slug}-mobile.webm`);
  const av1 = async (out, w, crf) =>
    run(FFMPEG, [
      "-y", "-i", srcAbs, ...trimArgs, "-an", "-sn", "-dn", "-pix_fmt", "yuv420p",
      "-c:v", "libsvtav1", "-preset", "7", "-crf", String(crf),
      "-svtav1-params", "tune=0:enable-overlays=1",
      "-g", "60", "-vf", vf(w), out,
    ], { maxBuffer: 1 << 28 }).then(() => true).catch(() => false);
  // SVT-AV1's CRF scale runs 0-63 and sits far below x264's at the same number;
  // 34 produced files LARGER than the capped H.264, so these are tuned to land
  // roughly 30% under the H.264 rendition at matching perceptual quality.
  const [okD, okM] = [await av1(dAv1, 1920, 46), await av1(mAv1, 1280, 50)];

  // Poster from ~1.5s in, past any fade-from-black at the head of the clip.
  const seek = Math.min(1.5, Math.max(0, duration - 0.5));
  const pAvif = path.join(TMP, `${slug}-poster.avif`);
  const pJpg = path.join(TMP, `${slug}-poster.jpg`);
  const pRaw = path.join(TMP, `${slug}-poster-raw.png`);
  await run(FFMPEG, ["-y", "-ss", String(seek), "-i", srcAbs, "-frames:v", "1",
    "-vf", "scale=1600:-2", pRaw]);
  // sharp handles AVIF here; ffmpeg's libaom still-picture path is not built in.
  await sharp(pRaw).jpeg({ quality: 72, mozjpeg: true, progressive: true }).toFile(pJpg);
  await sharp(pRaw).avif({ quality: 50, effort: 5 }).toFile(pAvif);
  await rm(pRaw, { force: true });

  const out = {
    original: rel,
    slug,
    duration,
    sourceBytes: srcBytes,
    desktop: await publish(dTmp, slug, "1080", "mp4"),
    mobile: await publish(mTmp, slug, "720", "mp4"),
    posterJpg: await publish(pJpg, slug, "poster", "jpg"),
  };
  if (existsSync(pAvif)) out.posterAvif = await publish(pAvif, slug, "poster", "avif");
  if (okD) out.desktopAv1 = await publish(dAv1, slug, "1080", "webm");
  if (okM) out.mobileAv1 = await publish(mAv1, slug, "720", "webm");

  const after = out.desktop.bytes + out.mobile.bytes;
  console.log(
    `${slug}\n  src ${(srcBytes / 1048576).toFixed(1)}MB` +
      `  ->  1080p ${(out.desktop.bytes / 1048576).toFixed(1)}MB` +
      ` + 720p ${(out.mobile.bytes / 1048576).toFixed(1)}MB` +
      `  (desktop saves ${(100 - (out.desktop.bytes / srcBytes) * 100).toFixed(0)}%)`,
  );
  return out;
}

await mkdir(OUT, { recursive: true });
await mkdir(TMP, { recursive: true });
const videos = (await findVideos(SITE)).sort();
console.log(`encoding ${videos.length} videos${TRIM ? ` (trimmed to ${TRIM}s)` : " (full length)"}\n`);

const results = [];
for (const v of videos) results.push(await encode(v));

await writeFile(
  path.join(ROOT, "video-manifest.json"),
  JSON.stringify(results, null, 2),
);
await rm(TMP, { recursive: true, force: true });

const src = results.reduce((n, r) => n + r.sourceBytes, 0);
const desk = results.reduce((n, r) => n + r.desktop.bytes, 0);
const mob = results.reduce((n, r) => n + r.mobile.bytes, 0);
console.log(
  `\nTOTAL  source ${(src / 1048576).toFixed(1)}MB` +
    `  ->  desktop set ${(desk / 1048576).toFixed(1)}MB` +
    `,  mobile set ${(mob / 1048576).toFixed(1)}MB`,
);
