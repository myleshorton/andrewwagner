// DO NOT RUN -- kept only as a record of an approach that does not work.
//
// Renaming the chunks to restore content-addressed filenames breaks the
// Turbopack module registry: the app loads, but React never hydrates and no
// console error is produced. Renaming turbopack-<hash>.js too (it carries the
// otherChunks list) is necessary but still not sufficient. The shipped
// alternative is to leave the filenames alone and let /_next/static/*
// revalidate instead of being immutable -- see tools/headers.template.
//
// Patching the bundle invalidated Turbopack's content-hash filenames: modified
// JS was still being served under its original name with `immutable` caching.
// Re-hash every chunk whose bytes no longer match its name and rewrite the
// references, so a changed chunk always gets a changed URL.
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const CHUNKS = path.join(SITE, "_next", "static", "chunks");
const STATE = path.join(ROOT, ".chunk-hashes.json");

const hash16 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

// Only rename chunks we actually touched. Re-running must be a no-op, so the
// applied mapping is recorded and replayed rather than recomputed.
let previous = {};
try {
  previous = JSON.parse(await readFile(STATE, "utf8"));
} catch {}

const renames = new Map();
for (const f of await readdir(CHUNKS)) {
  // turbopack-<hash>.js MUST be included: it carries the `otherChunks` list.
  // Renaming the chunks while leaving the runtime under its old (immutable)
  // URL means a returning browser reuses a cached runtime that points at the
  // pre-rename filenames, and the app never boots.
  const m = /^((?:turbopack-)?[0-9a-f]{16})(\.p[0-9a-f]{16})?\.js$/.exec(f);
  if (!m) continue;
  const buf = await readFile(path.join(CHUNKS, f));
  const h = hash16(buf);
  if (previous[f] === h) continue; // already correct
  const base = m[1];
  const next = `${base}.p${h}.js`;
  if (next === f) continue;
  renames.set(f, next);
}

if (renames.size === 0) {
  console.log("rehash: nothing to do");
} else {
  async function walk(dir, acc = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "media") continue;
        await walk(full, acc);
      } else if (/\.(html|js|json|txt)$/i.test(e.name)) acc.push(full);
    }
    return acc;
  }

  let refs = 0;
  for (const file of await walk(SITE)) {
    const src = await readFile(file, "utf8");
    let out = src;
    for (const [from, to] of renames) {
      if (!out.includes(from)) continue;
      out = out.split(from).join(to);
      refs++;
    }
    if (out !== src) await writeFile(file, out);
  }

  for (const [from, to] of renames) {
    await rename(path.join(CHUNKS, from), path.join(CHUNKS, to));
  }

  const state = {};
  for (const f of await readdir(CHUNKS)) {
    if (!f.endsWith(".js")) continue;
    state[f] = hash16(await readFile(path.join(CHUNKS, f)));
  }
  await writeFile(STATE, JSON.stringify(state, null, 2));

  console.log(`rehash: renamed ${renames.size} chunk(s), updated ${refs} reference site(s)`);
  for (const [from, to] of renames) console.log(`  ${from} -> ${to}`);
}
