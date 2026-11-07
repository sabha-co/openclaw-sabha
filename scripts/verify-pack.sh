#!/usr/bin/env bash
set -euo pipefail
sabha_smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/sabha-pack.XXXXXX")
trap 'rm -rf "$sabha_smoke_dir"' EXIT
export OPENCLAW_STATE_DIR="$sabha_smoke_dir/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
mkdir -p "$OPENCLAW_STATE_DIR"
# Under `npm run`, prepack's lifecycle output shares stdout, so find the
# tarball on disk rather than parsing `npm pack --json`.
npm pack --pack-destination "$sabha_smoke_dir" >/dev/null
sabha_archive=$(ls "$sabha_smoke_dir"/*.tgz)
node node_modules/openclaw/openclaw.mjs plugins install --force --accept-capabilities "$sabha_archive"
node node_modules/openclaw/openclaw.mjs plugins inspect sabha
node node_modules/openclaw/openclaw.mjs config validate
node node_modules/openclaw/openclaw.mjs sabha --help
node node_modules/openclaw/openclaw.mjs channels add --channel sabha --help
for mode in stream rewrite cancel; do
  node scripts/host-integration.mjs "$mode"
done
