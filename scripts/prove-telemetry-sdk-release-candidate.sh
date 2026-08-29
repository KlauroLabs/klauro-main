#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE_DIR="${1:-$REPO_ROOT/.telemetry-sdk-release}"
CANDIDATE_PARENT="$(dirname "$CANDIDATE_DIR")"
CANDIDATE_NAME="$(basename "$CANDIDATE_DIR")"
mkdir -p "$CANDIDATE_PARENT"
NEXT_DIR=""
STAGING=""
BACKUP_DIR=""
cleanup() {
  rc=$?
  rm -rf "$STAGING" "$NEXT_DIR"
  if [ "$rc" -ne 0 ] && [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ] && [ ! -e "$CANDIDATE_DIR" ]; then
    mv "$BACKUP_DIR" "$CANDIDATE_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT

EXPECTED_SHA="${KLAURO_RELEASE_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ACTUAL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "ERROR: requested source SHA does not match HEAD." >&2; exit 1; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || { echo "ERROR: telemetry SDK release source is dirty." >&2; exit 1; }
NEXT_DIR="$(mktemp -d "$CANDIDATE_PARENT/.${CANDIDATE_NAME}.candidate.XXXXXX")"
STAGING="$(mktemp -d)"

JS_VERSION="$(node -p "require('$REPO_ROOT/packages/klauro-sdk-js/package.json').version")"
PY_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO_ROOT/packages/klauro-sdk-py/pyproject.toml")"
[ -n "$PY_VERSION" ] || { echo "ERROR: Python SDK version is missing." >&2; exit 1; }
export KLAURO_RELEASE_SHA="$EXPECTED_SHA"
export KLAURO_JS_SDK_VERSION="$JS_VERSION"
export KLAURO_PY_SDK_VERSION="$PY_VERSION"
mkdir -p "$STAGING/js" "$STAGING/python"

npm --prefix "$REPO_ROOT/packages/klauro-sdk-js" run build
cp "$REPO_ROOT/packages/klauro-sdk-js/package.json" "$REPO_ROOT/packages/klauro-sdk-js/README.md" "$REPO_ROOT/LICENSE" "$STAGING/js/"
cp -R "$REPO_ROOT/packages/klauro-sdk-js/dist" "$STAGING/js/dist"
JS_TARBALL="$(npm pack "$STAGING/js" --pack-destination "$NEXT_DIR" --silent)"
JS_TARBALL="$(basename "$JS_TARBALL")"

cp "$REPO_ROOT/packages/klauro-sdk-py/pyproject.toml" "$REPO_ROOT/packages/klauro-sdk-py/README.md" "$REPO_ROOT/LICENSE" "$STAGING/python/"
cp -R "$REPO_ROOT/packages/klauro-sdk-py/src" "$STAGING/python/src"
python3 -m pip wheel --no-deps --wheel-dir "$NEXT_DIR" "$STAGING/python" >/dev/null
PY_WHEEL="$(find "$NEXT_DIR" -maxdepth 1 -type f -name '*.whl' -printf '%f\n')"
[ "$(printf '%s\n' "$PY_WHEEL" | sed '/^$/d' | wc -l)" -eq 1 ] || { echo "ERROR: expected exactly one Python wheel." >&2; exit 1; }

JS_INSTALL="$STAGING/js-install"
mkdir -p "$JS_INSTALL"
JS_INSTALL_COMMAND=(npm install --prefix "$JS_INSTALL" --ignore-scripts --no-audit --no-fund "$NEXT_DIR/$JS_TARBALL")
"${JS_INSTALL_COMMAND[@]}" >/dev/null
JS_SMOKE_COMMAND=(node -e "const sdk=require('$JS_INSTALL/node_modules/@klauro/telemetry'); if(typeof sdk.init!=='function') process.exit(1)")
"${JS_SMOKE_COMMAND[@]}"
python3 -m venv "$STAGING/python-install"
PY_INSTALL_COMMAND=("$STAGING/python-install/bin/pip" install --no-deps "$NEXT_DIR/$PY_WHEEL")
"${PY_INSTALL_COMMAND[@]}" >/dev/null
PY_SMOKE_COMMAND=("$STAGING/python-install/bin/python" -c "import klauro_telemetry; assert callable(klauro_telemetry.init)")
"${PY_SMOKE_COMMAND[@]}"

export REPO_ROOT NEXT_DIR JS_TARBALL PY_WHEEL
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { readSdkArchiveInventory } from './scripts/telemetry-sdk-release-integrity.mjs';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const candidate = process.env.NEXT_DIR;
const artifact = (kind, filename, command, smokeCommand) => {
  const artifactPath = path.join(candidate, filename);
  const artifactSha256 = digest(artifactPath);
  const entries = readSdkArchiveInventory(kind, artifactPath);
  return {
    kind, filename, sha256: artifactSha256,
    inventory_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    install_proof: { artifact_sha256: artifactSha256, isolated: true, command, smoke_command: smokeCommand },
  };
};
const manifest = {
  schema_version: 1,
  source_sha: process.env.KLAURO_RELEASE_SHA,
  git_clean: true,
  javascript_version: process.env.KLAURO_JS_SDK_VERSION,
  python_version: process.env.KLAURO_PY_SDK_VERSION,
  install_smoke: true,
  license_sha256: digest(path.join(process.env.REPO_ROOT, 'LICENSE')),
  local_installable: true,
  distributable: false,
  publishable: false,
  blockers: ['private_beta_license_requires_distribution_authorization', 'registry_publication_not_performed'],
  artifacts: [
    artifact('javascript', process.env.JS_TARBALL,
      ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', process.env.JS_TARBALL],
      ['node', '-e', "require('@klauro/telemetry').init"]),
    artifact('python', process.env.PY_WHEEL,
      ['python3', '-m', 'pip', 'install', '--no-deps', process.env.PY_WHEEL],
      ['python3', '-c', 'import klauro_telemetry']),
  ],
};
writeFileSync(path.join(candidate, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

node "$REPO_ROOT/scripts/telemetry-sdk-release-integrity.mjs" write "$NEXT_DIR"
node "$REPO_ROOT/scripts/telemetry-sdk-release-integrity.mjs" verify "$NEXT_DIR"
[ "${KLAURO_RELEASE_FAIL_AFTER_VERIFY:-0}" != "1" ] || { echo "ERROR: injected failure after candidate verification." >&2; exit 1; }
node "$REPO_ROOT/scripts/telemetry-sdk-release-integrity.mjs" install "$NEXT_DIR" "$CANDIDATE_DIR"
trap - EXIT
rm -rf "$STAGING"
printf 'Telemetry SDK release candidate verified at %s\n' "$CANDIDATE_DIR"
