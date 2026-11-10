#!/usr/bin/env bash
# Builds ecamm-mcp.mcpb, the one-click Claude desktop extension.
# Stages only what runs (dist + production dependencies) so the bundle stays small.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
rm -rf .bundle && mkdir .bundle
cp -R dist manifest.json package.json package-lock.json README.md LICENSE .bundle/
(cd .bundle && npm ci --omit=dev --ignore-scripts  --no-audit --no-fund)
npx --yes @anthropic-ai/mcpb@2 validate .bundle/manifest.json
npx --yes @anthropic-ai/mcpb@2 pack .bundle ecamm-mcp.mcpb
rm -rf .bundle
echo "Built ecamm-mcp.mcpb"
