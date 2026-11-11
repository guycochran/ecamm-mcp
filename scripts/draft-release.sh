#!/bin/bash
# Only attach artifacts to a draft. Never change an already-published release.
set -euo pipefail
tag="${GITHUB_REF_NAME:?Expected a release tag}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Unexpected release tag' >&2; exit 1; }
assets=(release/ecamm-mcp.mcpb release/ecamm-mcp.cjs release/SHA256SUMS.txt)
if state="$(gh release view "$tag" --json isDraft --jq .isDraft)"; then
  [ "$state" = true ] || { echo 'Refusing to modify a published release.' >&2; exit 1; }
  gh release upload "$tag" "${assets[@]}" --clobber
else
  notes="docs/release-notes/$tag.md"
  if [ -f "$notes" ]; then
    gh release create "$tag" "${assets[@]}" --draft --title "ecamm-mcp $tag" --notes-file "$notes"
  else
    gh release create "$tag" "${assets[@]}" --draft --title "ecamm-mcp $tag" --generate-notes
  fi
fi
