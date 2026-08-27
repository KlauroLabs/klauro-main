#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE_DIR="${1:-$REPO_ROOT/.telemetry-sdk-release}"
EXPECTED_SHA="${KLAURO_RELEASE_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ACTUAL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "ERROR: requested source SHA does not match HEAD." >&2; exit 1; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || { echo "ERROR: telemetry SDK release source is dirty." >&2; exit 1; }

JS_VERSION="$(node -p "require('$REPO_ROOT/packages/klauro-sdk-js/package.json').version")"
PY_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO_ROOT/packages/klauro-sdk-py/pyproject.toml")"
[ -n "$PY_VERSION" ] || { echo "ERROR: Python SDK version is missing." >&2; exit 1; }
export KLAURO_RELEASE_SHA="$EXPECTED_SHA"
export KLAURO_JS_SDK_VERSION="$JS_VERSION"
export KLAURO_PY_SDK_VERSION="$PY_VERSION"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
rm -rf "$CANDIDATE_DIR"
mkdir -p "$CANDIDATE_DIR" "$STAGING/js" "$STAGING/python"

npm --prefix "$REPO_ROOT/packages/klauro-sdk-js" run build
cp "$REPO_ROOT/packages/klauro-sdk-js/package.json" "$REPO_ROOT/packages/klauro-sdk-js/README.md" "$REPO_ROOT/LICENSE" "$STAGING/js/"
cp -R "$REPO_ROOT/packages/klauro-sdk-js/dist" "$STAGING/js/dist"
JS_TARBALL="$(npm pack "$STAGING/js" --pack-destination "$CANDIDATE_DIR" --silent)"
JS_TARBALL="$(basename "$JS_TARBALL")"

cp "$REPO_ROOT/packages/klauro-sdk-py/pyproject.toml" "$REPO_ROOT/packages/klauro-sdk-py/README.md" "$REPO_ROOT/LICENSE" "$STAGING/python/"
cp -R "$REPO_ROOT/packages/klauro-sdk-py/src" "$STAGING/python/src"
python3 -m pip wheel --no-deps --wheel-dir "$CANDIDATE_DIR" "$STAGING/python" >/dev/null
PY_WHEEL="$(find "$CANDIDATE_DIR" -maxdepth 1 -type f -name '*.whl' -printf '%f\n')"
[ "$(printf '%s\n' "$PY_WHEEL" | sed '/^$/d' | wc -l)" -eq 1 ] || { echo "ERROR: expected exactly one Python wheel." >&2; exit 1; }

JS_INSTALL="$STAGING/js-install"
mkdir -p "$JS_INSTALL"
npm install --prefix "$JS_INSTALL" --ignore-scripts --no-audit --no-fund "$CANDIDATE_DIR/$JS_TARBALL" >/dev/null
node -e "const sdk=require('$JS_INSTALL/node_modules/@klauro/telemetry'); if(typeof sdk.init!=='function') process.exit(1)"
python3 -m venv "$STAGING/python-install"
"$STAGING/python-install/bin/pip" install --no-deps "$CANDIDATE_DIR/$PY_WHEEL" >/dev/null
"$STAGING/python-install/bin/python" -c "import klauro_telemetry; assert callable(klauro_telemetry.init)"

JS_ENTRIES="$(tar -tzf "$CANDIDATE_DIR/$JS_TARBALL")"
PY_ENTRIES="$(unzip -Z1 "$CANDIDATE_DIR/$PY_WHEEL")"
export CANDIDATE_DIR JS_TARBALL PY_WHEEL JS_ENTRIES PY_ENTRIES
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const candidate = process.env.CANDIDATE_DIR;
const manifest = {
  schema_version: 1,
  source_sha: process.env.KLAURO_RELEASE_SHA,
  git_clean: true,
  javascript_version: process.env.KLAURO_JS_SDK_VERSION,
  python_version: process.env.KLAURO_PY_SDK_VERSION,
  install_smoke: true,
  publishable: false,
  blockers: ['license_metadata_review', 'registry_publication_not_performed'],
  artifacts: [
    {
      kind: 'javascript',
      filename: process.env.JS_TARBALL,
      sha256: digest(path.join(candidate, process.env.JS_TARBALL)),
      entries: process.env.JS_ENTRIES.split('\n').filter(Boolean),
    },
    {
      kind: 'python',
      filename: process.env.PY_WHEEL,
      sha256: digest(path.join(candidate, process.env.PY_WHEEL)),
      entries: process.env.PY_ENTRIES.split('\n').filter(Boolean),
    },
  ],
};
writeFileSync(path.join(candidate, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

node "$REPO_ROOT/scripts/telemetry-sdk-release-integrity.mjs" write "$CANDIDATE_DIR"
node "$REPO_ROOT/scripts/telemetry-sdk-release-integrity.mjs" verify "$CANDIDATE_DIR"
printf 'Telemetry SDK release candidate verified at %s\n' "$CANDIDATE_DIR"
