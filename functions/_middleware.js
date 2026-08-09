// Cloudflare Pages middleware for the optimized mirror.
//
// Two jobs:
//  1. Answer Next.js RSC prefetches with the captured flight payloads, so
//     client-side navigation works instead of parsing HTML as JSON.
//  2. Serve AVIF/WebP in place of JPEG, and the narrow rendition on constrained
//     clients. Variant URLs are derived by string substitution rather than a
//     lookup table: images are /media/i/<slug>.<hash>.w<width>.<ext> and posters
//     are /media/v/<slug>-poster.<hash>.jpg. A missing variant simply 404s from
//     the asset store and we fall back to what was originally requested.

const NEGOTIABLE = /^\/media\/(i|v)\/.+\.jpg$/;
const R2_HIGH = /^\/media\/v\/.+-high\.[0-9a-f]{8}\.mp4$/;

const RSC_ROUTES = {
  "/": "index",
  "/studio": "studio",
  "/work/commercial": "work-commercial",
  "/work/residential": "work-residential",
};

function rscName(pathname) {
  const clean = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return RSC_ROUTES[clean];
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") return next();

  // ---- full-quality hero video, proxied from R2 ----------------------------
  // These exceed the 25 MiB Pages asset limit, so they are stored in R2 and
  // served under the same /media/v/ path. Range requests must work or the
  // browser cannot seek, and Safari will refuse to start playback at all.
  if (R2_HIGH.test(url.pathname) && env.MEDIA) {
    const key = url.pathname.slice(1);
    const range = request.headers.get("range");
    const parsed = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    // R2 reports a `range` on every object, including full reads, so the
    // response status has to follow what the CLIENT asked for. Returning 206
    // to a request that sent no Range header is invalid HTTP.
    const isPartial = Boolean(parsed && parsed[1] !== "");
    let obj;
    if (isPartial) {
      const offset = Number(parsed[1]);
      const end = parsed[2] === "" ? undefined : Number(parsed[2]);
      obj = await env.MEDIA.get(key, {
        range: end === undefined ? { offset } : { offset, length: end - offset + 1 },
      });
    } else {
      obj = await env.MEDIA.get(key);
    }
    if (!obj) return next();

    const headers = new Headers();
    headers.set("Content-Type", "video/mp4");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", obj.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    if (isPartial) {
      const start = obj.range?.offset ?? 0;
      const len = obj.range?.length ?? obj.size - start;
      headers.set("Content-Range", `bytes ${start}-${start + len - 1}/${obj.size}`);
      headers.set("Content-Length", String(len));
      return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(obj.size));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
  }

  if (request.method !== "GET") return next();

  // ---- RSC prefetch --------------------------------------------------------
  const wantsRsc = url.searchParams.has("_rsc") || request.headers.get("rsc") === "1";
  if (wantsRsc) {
    const name = rscName(url.pathname);
    if (name) {
      const payload = new URL(url);
      payload.search = "";
      payload.pathname = `/__rsc/${name}.txt`;
      const res = await env.ASSETS.fetch(new Request(payload, { method: "GET" }));
      if (res.ok) {
        const out = new Response(res.body, res);
        out.headers.set("Content-Type", "text/x-component");
        out.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
        return out;
      }
    }
    return next();
  }

  // ---- image negotiation ---------------------------------------------------
  if (!NEGOTIABLE.test(url.pathname)) return next();

  const accept = request.headers.get("accept") || "";
  const saveData = request.headers.get("save-data") === "on";

  // Sec-CH-Viewport-Width is CSS px; multiply by DPR for the real pixel need.
  const vw = Number(request.headers.get("sec-ch-viewport-width") || 0);
  const dpr = Number(request.headers.get("sec-ch-dpr") || 1) || 1;
  const needed = vw > 0 ? vw * dpr : 0;

  let pathname = url.pathname;
  if (saveData || (needed > 0 && needed <= 1280)) {
    pathname = pathname.replace(".w2048.", ".w1280.");
  }

  const VARY = "Accept, Sec-CH-Viewport-Width, Sec-CH-DPR, Save-Data";
  const formats = [];
  if (accept.includes("image/avif")) formats.push(".avif");
  if (accept.includes("image/webp")) formats.push(".webp");

  for (const ext of formats) {
    const candidate = new URL(url);
    candidate.pathname = pathname.replace(/\.jpg$/, ext);
    const res = await env.ASSETS.fetch(new Request(candidate, request));
    if (res.ok) {
      const out = new Response(res.body, res);
      out.headers.set("Vary", VARY);
      return out;
    }
  }

  if (pathname !== url.pathname) {
    const narrow = new URL(url);
    narrow.pathname = pathname;
    const res = await env.ASSETS.fetch(new Request(narrow, request));
    if (res.ok) {
      const out = new Response(res.body, res);
      out.headers.set("Vary", VARY);
      return out;
    }
  }

  return next();
}
