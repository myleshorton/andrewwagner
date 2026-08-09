// Next's App Router prefetches an RSC flight payload for every link. A static
// mirror answers those with HTML, which makes the client log a JSON parse error
// and fall back to full page loads. Capture the real payloads from the origin,
// repoint their image paths at the optimized variants, and let the middleware
// serve them so client-side navigation keeps working.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.join(SITE, "__rsc");
const ORIGIN = "https://www.andrewwagnerarchitects.com";

const PAGES = {
  "/": "index",
  "/studio": "studio",
  "/work/commercial": "work-commercial",
  "/work/residential": "work-residential",
};

const imageManifest = JSON.parse(await readFile(path.join(ROOT, "image-manifest.json"), "utf8"));
const replacements = [];
for (const img of imageManifest) {
  if (img.original === "/favicon.jpg") continue;
  replacements.push([img.original, img.defaultUrl]);
  const enc = encodeURI(img.original);
  if (enc !== img.original) replacements.push([enc, img.defaultUrl]);
  // Flight payloads embed paths inside JSON strings, so spaces arrive escaped.
  replacements.push([img.original.replace(/"/g, '\\"'), img.defaultUrl]);
}
replacements.sort((a, b) => b[0].length - a[0].length);

await mkdir(OUT, { recursive: true });
for (const [route, name] of Object.entries(PAGES)) {
  const res = await fetch(encodeURI(ORIGIN + route) + "?_rsc=1vkje", {
    headers: { RSC: "1", Accept: "*/*" },
  });
  if (!res.ok) {
    console.warn(`!! ${route}: ${res.status}`);
    continue;
  }
  let body = await res.text();
  let hits = 0;
  for (const [from, to] of replacements) {
    if (!body.includes(from)) continue;
    body = body.split(from).join(to);
    hits++;
  }
  await writeFile(path.join(OUT, `${name}.txt`), body);
  console.log(`rsc ${route} -> __rsc/${name}.txt  (${body.length} bytes, ${hits} image refs rewritten)`);
}
