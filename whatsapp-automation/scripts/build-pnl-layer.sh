#!/usr/bin/env bash
# Build the Lambda layer that carries exceljs to wa-pnl-report.
#
# The service's Lambda asset excludes node_modules (iac/lib/stack.js), so this
# is the only route an npm package takes into production here. Run it before
# `cdk synth`, `cdk diff` or `cdk deploy`: synth refuses when the layer is
# missing rather than shipping a function that throws on its first import.
#
# Layout is Lambda's, not ours: a layer's Node modules must live at
# nodejs/node_modules/ inside the zip or the runtime will not resolve them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$HERE/iac/layers/pnl/nodejs"

mkdir -p "$DIR"
[ -f "$DIR/package.json" ] || echo '{"name":"pnl-layer","private":true}' > "$DIR/package.json"

# --omit=dev so the layer carries only what runs: no vitest, no typescript.
npm install --omit=dev --no-audit --no-fund --prefix "$DIR" exceljs

if [ ! -d "$DIR/node_modules/exceljs" ]; then
  echo "build-pnl-layer: exceljs is still missing from $DIR/node_modules" >&2
  exit 1
fi
echo "P&L layer built: $(du -sh "$DIR/node_modules" | cut -f1) at $DIR/node_modules"
