// Adds a "high" rendition: the ORIGINAL 1080p video stream, remuxed rather
// than re-encoded, so there is zero generational quality loss.
//
// `-c:v copy` keeps the source bitrate exactly as shot while still fixing the
// two things that were wrong with the originals as delivered: the AAC track on
// a muted background video, and the moov atom sitting at the end of two files
// (which forces a full download before the first frame).
//
// Sources were deleted from site/ after the path rewrite, so they are pulled
// back from the origin here.
import { readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";

const run = promisify(execFile);
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.join(ROOT, "r2-high");
const TMP = path.join(ROOT, ".tmp-high");
const ORIGIN = "https://www.andrewwagnerarchitects.com";

const hash8 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 8);
const mb = (n) => (n / 1048576).toFixed(1);

await mkdir(TMP, { recursive: true });
await mkdir(OUT, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(ROOT, "video-manifest.json"), "utf8"));

for (const v of manifest) {
  const src = path.join(TMP, `${v.slug}-src.mp4`);
  const res = await fetch(encodeURI(ORIGIN + v.original));
  if (!res.ok) {
    console.warn(`  !! ${v.original}: ${res.status}`);
    continue;
  }
  await writeFile(src, Buffer.from(await res.arrayBuffer()));

  // Cloudflare Pages rejects any file over 25 MiB, and three of these
  // originals are 28-51 MB. Copy the stream untouched when it fits; otherwise
  // re-encode at the highest bitrate that does, which is still far above the
  // 2,000 kbps capped tier.
  const LIMIT = Infinity; // R2 has no per-object size limit
  const out = path.join(TMP, `${v.slug}-high.mp4`);
  const fits = v.sourceBytes <= LIMIT;

  if (fits) {
    await run(FFMPEG, [
      "-y", "-i", src,
      "-c:v", "copy",   // no re-encode: bit-for-bit the original video stream
      "-an", "-sn", "-dn",
      "-movflags", "+faststart",
      out,
    ], { maxBuffer: 1 << 28 });
  } else {
    const kbps = Math.floor((LIMIT * 8) / v.duration / 1000);
    await run(FFMPEG, [
      "-y", "-i", src,
      "-an", "-sn", "-dn",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "slow",
      "-crf", "20",
      "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      out,
    ], { maxBuffer: 1 << 28 });
  }

  const buf = await readFile(out);
  const name = `${v.slug}-high.${hash8(buf)}.mp4`;
  await rename(out, path.join(OUT, name));
  v.high = { url: `/media/v/${name}`, bytes: buf.length };

  console.log(
    `${v.slug.slice(0, 46)}\n  source ${mb(v.sourceBytes)}MB -> high ${mb(buf.length)}MB` +
      ` ${fits ? "(lossless remux)" : "(re-encoded to fit Pages)"}  |  capped desktop ${mb(v.desktop.bytes)}MB  |  mobile ${mb(v.mobile.bytes)}MB`,
  );
  await rm(src, { force: true });
}

await writeFile(path.join(ROOT, "video-manifest.json"), JSON.stringify(manifest, null, 2));
await rm(TMP, { recursive: true, force: true });

const hi = manifest.reduce((n, v) => n + (v.high ? v.high.bytes : 0), 0);
const de = manifest.reduce((n, v) => n + v.desktop.bytes, 0);
console.log(`\nhigh set ${mb(hi)}MB   (capped desktop set was ${mb(de)}MB)`);
