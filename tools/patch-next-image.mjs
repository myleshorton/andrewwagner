// Two follow-on patches to the mirrored bundle, both idempotent.
//
// 1. next/image is bundled but neutered by `unoptimized:!0`, which is why the
//    live site emits bare <img src> with no srcset. Flipping it on and swapping
//    the loader for one that maps to our pre-built width variants gives real
//    responsive images without touching a single call site.
// 2. Cloudflare's email obfuscation depends on a /cdn-cgi/ script that does not
//    exist on Pages, so the address would stay scrambled and the console would
//    log a MIME-type error. Decode it at build time instead.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const CHUNKS = path.join(SITE, "_next", "static", "chunks");

// ---- 1. next/image ---------------------------------------------------------
// Only these two widths exist on disk; the loader snaps any requested width to
// the nearest one that is at least as large.
const WIDTHS = "[1280,2048]";

const LOADER_BODY =
  `function n(e){` +
  `let s=e.src,w=e.width;` +
  `let m=/^(\\/media\\/i\\/.+)\\.w(\\d+)\\.(jpg|jpeg|png|webp|avif)$/.exec(s);` +
  `if(!m)return s;` +
  `let a=${WIDTHS},p=a[a.length-1];` +
  `for(let i=0;i<a.length;i++){if(a[i]>=w){p=a[i];break}}` +
  `return m[1]+".w"+p+"."+m[3]}`;

const LOADER_RE =
  /function n\(e\)\{var t;let\{config:r,src:n,width:o,quality:i\}=e,u=i\|\|\(null==\(t=r\.qualities\)\?void 0:t\.reduce\(\(e,t\)=>Math\.abs\(t-75\)<Math\.abs\(e-75\)\?t:e\)\)\|\|75;return r\.path\+"\?url="\+encodeURIComponent\(n\)\+"&w="\+o\+"&q="\+u\+\(n\.startsWith\("\/_next\/static\/media\/"\),""\)\}/;

let loaderPatched = 0;
let configPatched = 0;

// Off by default: flipping `unoptimized` stopped the Turbopack entry from
// executing at all (no hydration, no console error), so the srcset win is not
// worth a dead page. Set NEXT_IMAGE=1 to experiment with it again.
for (const f of process.env.NEXT_IMAGE ? await readdir(CHUNKS) : []) {
  if (!f.endsWith(".js")) continue;
  const full = path.join(CHUNKS, f);
  const src = await readFile(full, "utf8");
  let out = src;

  if (LOADER_RE.test(out)) {
    out = out.replace(LOADER_RE, LOADER_BODY);
    loaderPatched++;
  }

  if (out.includes("unoptimized:!0")) {
    out = out.split("unoptimized:!0").join("unoptimized:!1");
    configPatched++;
  }
  // Restrict the candidate widths to what we actually built, so srcSet lists
  // two real renditions instead of eight aliases of the same two files.
  out = out
    .split("deviceSizes:[640,750,828,1080,1200,1920,2048,3840]")
    .join(`deviceSizes:${WIDTHS}`)
    .split("imageSizes:[16,32,48,64,96,128,256,384]")
    .join("imageSizes:[1280]");

  if (out !== src) {
    await writeFile(full, out);
    await run("/opt/homebrew/bin/node", ["--check", full]);
  }
}
console.log(`next/image: loader patched in ${loaderPatched} chunk(s), unoptimized flipped in ${configPatched}`);

// ---- 2. Cloudflare email obfuscation --------------------------------------
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

async function htmlFiles(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "media" || e.name === "_next") continue;
      await htmlFiles(full, acc);
    } else if (e.name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

const CF_LINK = /<a href="\/cdn-cgi\/l\/email-protection"([^>]*?)data-cfemail="([0-9a-fA-F]+)"([^>]*)>.*?<\/a>/g;
const CF_SCRIPT = /<script data-cfasync="false"[^>]*email-decode\.min\.js"[^>]*><\/script>/g;

let emails = 0;
for (const file of await htmlFiles(SITE)) {
  const src = await readFile(file, "utf8");
  let out = src.replace(CF_LINK, (_m, pre, hex, post) => {
    const addr = decodeCfEmail(hex);
    emails++;
    // Drop the __cf_email__ class so nothing tries to re-decode a live mailto.
    const attrs = (pre + post).replace(/\s*class="__cf_email__"/, "").trim();
    return `<a href="mailto:${addr}"${attrs ? " " + attrs : ""}>${addr}</a>`;
  });
  out = out.replace(CF_SCRIPT, "");
  if (out !== src) await writeFile(file, out);
}
console.log(`email: decoded ${emails} obfuscated address(es), removed /cdn-cgi decode script`);
