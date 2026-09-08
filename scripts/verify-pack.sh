#!/usr/bin/env bash
set -euo pipefail
sabha_smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/sabha-pack.XXXXXX")
trap 'rm -rf "$sabha_smoke_dir"' EXIT
export OPENCLAW_STATE_DIR="$sabha_smoke_dir/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
mkdir -p "$OPENCLAW_STATE_DIR"
npm pack --pack-destination "$sabha_smoke_dir" --json > "$sabha_smoke_dir/pack.json"
sabha_archive=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1]))[0].filename)' "$sabha_smoke_dir/pack.json")
node node_modules/openclaw/openclaw.mjs plugins install --force --accept-capabilities "$sabha_smoke_dir/$sabha_archive"
node node_modules/openclaw/openclaw.mjs plugins inspect sabha
node node_modules/openclaw/openclaw.mjs config validate
node node_modules/openclaw/openclaw.mjs sabha --help
node node_modules/openclaw/openclaw.mjs channels add --channel sabha --help
for mode in stream rewrite cancel; do
  node scripts/host-integration.mjs "$mode"
done
