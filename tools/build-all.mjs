// Single entry point for rebuilding (and optionally deploying) the optimized
// mirror. Run this instead of the individual tools -- the steps are
// order-dependent in ways that fail confusingly when done by hand:
//
//   * build.mjs is NOT idempotent. It finds the player by the literal string
//     `50431,e=>{`, which its own output no longer matches, so it must always
//     run against a freshly mirrored bundle. This script re-mirrors first.
//   * fetch-rsc.mjs must run AFTER the bundle is final. The flight payloads
//     embed chunk filenames; if they go stale, Next requests URLs that do not
//     exist, Pages answers with the HTML fallback, and Chrome reports
//     "MIME type ('text/html') is not executable" while the page silently
//     fails to hydrate.
//
// Usage:
//   node tools/build-all.mjs                 rebuild markup/bundle, reuse media
//   node tools/build-all.mjs --media         also re-download and re-encode media
//   node tools/build-all.mjs --deploy        rebuild, then publish
//   node tools/build-all.mjs --trim=12       short hero loops (implies --media)
import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const NODE = process.execPath;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const trim = (args.find((a) => a.startsWith("--trim=")) || "").split("=")[1];
const withMedia = has("--media") || Boolean(trim);
const deploy = has("--deploy");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "9c1ed3ed0d1358469d08ae59a4e64d3b";
const PROJECT = process.env.PROJECT_NAME || "awa-optimized";

function run(cmd, cmdArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${cmdArgs.join(" ")} exited ${code}`)),
    );
  });
}

const step = (n, label) => console.log(`\n\x1b[1m[${n}] ${label}\x1b[0m`);
const tool = (name, env) => run(NODE, [path.join("tools", name)], env);

// 1. Clean the generated markup/bundle. Media under site/media is preserved
//    unless --media, since re-encoding costs ~20 minutes.
step(1, withMedia ? "clean (full, including media)" : "clean (bundle + markup only)");
for (const p of ["_next", "index.html", "studio", "work", "__rsc"]) {
  await rm(path.join(SITE, p), { recursive: true, force: true });
}
await rm(path.join(ROOT, ".chunk-hashes.json"), { force: true });
if (withMedia) await rm(SITE, { recursive: true, force: true });

// 2. Mirror.
step(2, withMedia ? "mirror origin (pages + assets + media)" : "mirror origin (pages + assets)");
await tool("mirror.mjs", withMedia ? {} : { SKIP_MEDIA: "1" });

// 3. Media pipeline, only when asked.
if (withMedia) {
  step(3, "optimize images");
  await tool("optimize-images.mjs");
  step(4, `encode video${trim ? ` (trimmed to ${trim}s)` : " (full length)"}`);
  await tool("encode-video.mjs", trim ? { TRIM_SECONDS: trim } : {});
  step("4b", "stage lossless high tier + upload to R2");
  await tool("add-high-rendition.mjs");
  await run(path.join(ROOT, "node_modules/.bin/wrangler"), ["r2", "bucket", "create", "awa-media"], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }).catch(() => {});
  for (const f of (await import("node:fs")).readdirSync(path.join(ROOT, "r2-high"))) {
    await run(path.join(ROOT, "node_modules/.bin/wrangler"), [
      "r2", "object", "put", `awa-media/media/v/${f}`,
      "--file", path.join(ROOT, "r2-high", f),
      "--content-type", "video/mp4", "--remote",
    ], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID });
  }
} else {
  for (const m of ["image-manifest.json", "video-manifest.json"]) {
    if (!existsSync(path.join(ROOT, m))) {
      throw new Error(`${m} missing -- run with --media to build the media pipeline first`);
    }
  }
  console.log("    reusing existing media + manifests (pass --media to rebuild)");
}

// 4. Patch the bundle: player module, image paths, headers.
step(withMedia ? 5 : 3, "patch bundle (player, image paths, headers)");
await tool("build.mjs");

// 5. Decode Cloudflare's email obfuscation.
step(withMedia ? 6 : 4, "decode obfuscated email");
await tool("patch-next-image.mjs");

// 6. RSC payloads LAST -- they pin chunk filenames.
step(withMedia ? 7 : 5, "capture RSC flight payloads");
await tool("fetch-rsc.mjs");

// 7. Guard: the failure mode this script exists to prevent.
step(withMedia ? 8 : 6, "verify chunk references agree");
const onDisk = new Set(
  (await import("node:fs")).readdirSync(path.join(SITE, "_next/static/chunks")).filter((f) => f.endsWith(".js")),
);
const referenced = new Set();
for (const f of ["index.html", "studio/index.html", "work/commercial/index.html", "work/residential/index.html"]) {
  const src = await readFile(path.join(SITE, f), "utf8");
  for (const m of src.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9._-]+\.js)/g)) referenced.add(m[1]);
}
for (const f of ["index", "studio", "work-commercial", "work-residential"]) {
  const src = await readFile(path.join(SITE, "__rsc", `${f}.txt`), "utf8");
  for (const m of src.matchAll(/static\/chunks\/([A-Za-z0-9._-]+\.js)/g)) referenced.add(m[1]);
}
const missing = [...referenced].filter((r) => !onDisk.has(r));
if (missing.length) {
  console.error(`\n\x1b[31m!! ${missing.length} referenced chunk(s) not on disk:\x1b[0m`);
  for (const m of missing) console.error(`   ${m}`);
  throw new Error("chunk reference mismatch -- deploy would fail to hydrate");
}
console.log(`    ${referenced.size} referenced chunks all present`);

// 8. Deploy.
if (deploy) {
  step(withMedia ? 9 : 7, `deploy to ${PROJECT}.pages.dev`);
  await run(path.join(ROOT, "node_modules/.bin/wrangler"), [
    "pages", "deploy",
    "--project-name", PROJECT,
    "--branch", "main",
    "--commit-dirty=true",
  ], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID });
} else {
  console.log(`\n\x1b[1mbuild complete.\x1b[0m re-run with --deploy to publish.`);
}
