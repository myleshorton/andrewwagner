// Mirrors andrewwagnerarchitects.com into ./site as a static tree.
// Discovery is static: page HTML -> _next assets -> JS chunks -> media paths.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ORIGIN = "https://www.andrewwagnerarchitects.com";
const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const PAGES = ["/", "/studio", "/work/commercial", "/work/residential"];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function get(urlPath, { binary = false } = {}) {
  const res = await fetch(encodeURI(ORIGIN + urlPath), { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${urlPath}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function save(relPath, data) {
  const dest = path.join(SITE, relPath);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
  return dest;
}

// ---- 1. pages -------------------------------------------------------------
const htmlByPage = new Map();
for (const p of PAGES) {
  const html = await get(p);
  htmlByPage.set(p, html);
  const rel = p === "/" ? "index.html" : `${p.replace(/^\//, "")}/index.html`;
  await save(rel, html);
  console.log(`page  ${p}  (${html.length} bytes)`);
}

// ---- 2. _next static assets ----------------------------------------------
const nextAssets = new Set();
for (const html of htmlByPage.values()) {
  for (const m of html.matchAll(/\/_next\/static\/[A-Za-z0-9._\/-]+/g)) nextAssets.add(m[0]);
}
console.log(`\n_next assets referenced by HTML: ${nextAssets.size}`);

// Chunks can import further chunks; follow one level of transitive refs.
const chunkQueue = [...nextAssets].filter((a) => a.endsWith(".js"));
const seenChunks = new Set();
const chunkSources = new Map();
while (chunkQueue.length) {
  const c = chunkQueue.shift();
  if (seenChunks.has(c)) continue;
  seenChunks.add(c);
  let body;
  try {
    body = await get(c);
  } catch (e) {
    console.warn(`  !! ${c}: ${e.message}`);
    continue;
  }
  chunkSources.set(c, body);
  nextAssets.add(c);
  for (const m of body.matchAll(/\/_next\/static\/[A-Za-z0-9._\/-]+/g)) {
    nextAssets.add(m[0]);
    if (m[0].endsWith(".js") && !seenChunks.has(m[0])) chunkQueue.push(m[0]);
  }
  // static/chunks/<hash>.js referenced only as a bare hash in the manifest
  for (const m of body.matchAll(/"static\/chunks\/([A-Za-z0-9._-]+\.js)"/g)) {
    const full = `/_next/static/chunks/${m[1]}`;
    nextAssets.add(full);
    if (!seenChunks.has(full)) chunkQueue.push(full);
  }
}
console.log(`_next assets after chunk crawl: ${nextAssets.size}`);

for (const a of nextAssets) {
  if (chunkSources.has(a)) {
    await save(a, chunkSources.get(a));
    continue;
  }
  try {
    await save(a, await get(a, { binary: true }));
  } catch (e) {
    console.warn(`  !! ${a}: ${e.message}`);
  }
}

// ---- 3. media referenced from HTML + chunks -------------------------------
if (process.env.SKIP_MEDIA) {
  console.log("\nSKIP_MEDIA set: leaving optimized media in place");
  process.exit(0);
}

const MEDIA_RE = /"(\/[^"'`]{1,240}?\.(?:mp4|webm|mov|jpg|jpeg|png|webp|avif|svg|ico|pdf))"/gi;
const HREF_RE = /(?:src|href)="(\/[^"]{1,240}?\.(?:mp4|webm|mov|jpg|jpeg|png|webp|avif|svg|ico|pdf))"/gi;
const media = new Set();
const addMedia = (u) => {
  if (u.startsWith("/_next/")) return;
  media.add(decodeURIComponent(u));
};
for (const html of htmlByPage.values()) {
  for (const m of html.matchAll(HREF_RE)) addMedia(m[1]);
  for (const m of html.matchAll(MEDIA_RE)) addMedia(m[1]);
}
for (const src of chunkSources.values()) {
  for (const m of src.matchAll(MEDIA_RE)) addMedia(m[1]);
}
for (const extra of ["/favicon.jpg", "/sitemap.xml", "/robots.txt"]) media.add(extra);

console.log(`\nmedia assets: ${media.size}`);
const manifest = [];
for (const m of [...media].sort()) {
  try {
    const buf = await get(m, { binary: true });
    await save(m, buf);
    manifest.push({ path: m, bytes: buf.length });
    console.log(`  ${String(buf.length).padStart(9)}  ${m}`);
  } catch (e) {
    console.warn(`  !! ${m}: ${e.message}`);
  }
}

await save(
  "../manifest.json",
  JSON.stringify(
    {
      pages: PAGES,
      nextAssets: [...nextAssets].sort(),
      media: manifest.sort((a, b) => b.bytes - a.bytes),
      totalMediaBytes: manifest.reduce((n, m) => n + m.bytes, 0),
    },
    null,
    2,
  ),
);
console.log(
  `\nTOTAL MEDIA: ${(manifest.reduce((n, m) => n + m.bytes, 0) / 1048576).toFixed(1)} MB`,
);
