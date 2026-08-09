#!/usr/bin/env bash
# Rebuild the optimized mirror and publish it to Cloudflare Pages.
# Passes through flags: --media to re-encode video/images, --trim=12 for short
# hero loops. Run `npx wrangler login` first if you need a different account.
set -euo pipefail
cd "$(dirname "$0")"
exec /opt/homebrew/bin/node tools/build-all.mjs --deploy "$@"
