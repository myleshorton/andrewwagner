// Rebuilds every source image as AVIF / WebP / JPEG at two widths.
//
// Variant names are derived deterministically from ONE hash of the source
// bytes -- /media/i/<slug>.<hash>.w<width>.<ext> -- so the Pages middleware can
// swap format and width by string manipulation alone, without a lookup table,
// while every URL stays content-addressed and safe to cache immutably.
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.join(SITE, "media", "i");
const WIDTHS = [1280, 2048];
const CONCURRENCY = 8;

const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

function slugify(p) {
  const base = path.basename(p, path.extname(p));
  const section = p.split("/")[1].replace(/ Page$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const s = base
    .toLowerCase()
    .replace(/andrew wagner architect?s?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return `${section}-${s}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function findImages(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "media" || e.name === "_next") continue;
      await findImages(full, acc);
    } else if (/\.(jpe?g|png)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

async function optimize(srcAbs) {
  const rel = "/" + path.relative(SITE, srcAbs).split(path.sep).join("/");
  const raw = await readFile(srcAbs);
  const h = hash8(raw);
  const slug = slugify(rel);
  const meta = await sharp(raw).metadata();
  const variants = {};
  let bytesOut = 0;

  // An equirectangular panorama (2:1, very wide) feeds a 360 viewer that shows
  // only ~90 degrees at a time, so 2048 across the full sphere looks soft. Give
  // the widest slot 4096 instead of adding a width the middleware can't derive.
  const isPanorama = meta.width >= 6000 && Math.abs(meta.width / meta.height - 2) < 0.02;

  for (const w of WIDTHS) {
    const slot = isPanorama && w === WIDTHS.at(-1) ? 4096 : w;
    // Never upscale: a narrow source just repeats at both width slots so the
    // middleware can always construct a URL that exists.
    const target = Math.min(slot, meta.width || slot);
    const base = sharp(raw, { failOn: "none" })
      .rotate()
      .resize({ width: target, withoutEnlargement: true });

    const jobs = [
      ["jpg", base.clone().jpeg({ quality: 78, mozjpeg: true, progressive: true }).toBuffer()],
      ["webp", base.clone().webp({ quality: 76, effort: 5 }).toBuffer()],
      ["avif", base.clone().avif({ quality: 52, effort: 5, chromaSubsampling: "4:2:0" }).toBuffer()],
    ];
    for (const [ext, p] of jobs) {
      const buf = await p;
      const name = `${slug}.${h}.w${w}.${ext}`;
      await writeFile(path.join(OUT, name), buf);
      variants[`w${w}.${ext}`] = { url: `/media/i/${name}`, bytes: buf.length };
      bytesOut += buf.length;
    }
  }

  return {
    original: rel,
    slug,
    hash: h,
    width: meta.width,
    height: meta.height,
    sourceBytes: raw.length,
    // What markup will point at: widest universally-decodable variant.
    defaultUrl: variants[`w${WIDTHS.at(-1)}.jpg`].url,
    bestBytes: variants[`w${WIDTHS.at(-1)}.avif`].bytes,
    variants,
    allVariantBytes: bytesOut,
  };
}

await mkdir(OUT, { recursive: true });
const images = (await findImages(SITE)).sort();
console.log(`optimizing ${images.length} images -> ${WIDTHS.length} widths x 3 formats\n`);

const results = [];
let done = 0;
const queue = [...images];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const img = queue.shift();
      try {
        const r = await optimize(img);
        results.push(r);
        done++;
        if (done % 10 === 0) console.log(`  ${done}/${images.length}`);
      } catch (e) {
        console.warn(`  !! ${img}: ${e.message}`);
      }
    }
  }),
);

results.sort((a, b) => b.sourceBytes - a.sourceBytes);
await writeFile(path.join(ROOT, "image-manifest.json"), JSON.stringify(results, null, 2));

const src = results.reduce((n, r) => n + r.sourceBytes, 0);
const best = results.reduce((n, r) => n + r.bestBytes, 0);
console.log(`\nworst offenders (source -> 2048 AVIF):`);
for (const r of results.slice(0, 6)) {
  console.log(
    `  ${(r.sourceBytes / 1048576).toFixed(2)}MB -> ${(r.bestBytes / 1024).toFixed(0)}KB  ${r.original}`,
  );
}
console.log(
  `\nTOTAL  source ${(src / 1048576).toFixed(1)}MB  ->  2048 AVIF set ${(best / 1048576).toFixed(1)}MB` +
    `  (${(100 - (best / src) * 100).toFixed(0)}% smaller)`,
);
