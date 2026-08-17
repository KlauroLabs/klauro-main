#!/usr/bin/env bash
set -euo pipefail

ACCOUNTS_FILE="${1:?accounts JSON path is required}"
WORKSPACES_DIR="${2:?workspace snapshot directory is required}"
DESTINATION="${3:?destination directory is required}"
SOURCE_PREFIX="${4:-}"

if [ ! -f "$ACCOUNTS_FILE" ]; then
  echo "accounts file does not exist: $ACCOUNTS_FILE" >&2
  exit 2
fi
if [ ! -d "$WORKSPACES_DIR" ]; then
  echo "workspace directory does not exist: $WORKSPACES_DIR" >&2
  exit 2
fi
if [ -e "$DESTINATION" ]; then
  echo "destination already exists: $DESTINATION" >&2
  exit 2
fi

DESTINATION_PARENT="$(dirname "$DESTINATION")"
mkdir -p "$DESTINATION_PARENT"
STAGING="$(mktemp -d "$DESTINATION_PARENT/.hosted-proof-corpus.XXXXXX")"
cleanup() {
  if [ -n "${STAGING:-}" ] && [ -d "$STAGING" ]; then
    rm -rf -- "$STAGING"
  fi
}
trap cleanup EXIT

PROJECTS_FILE="$STAGING/projects.tsv"
jq -r --arg source_prefix "$SOURCE_PREFIX" '
  .projects
  | map(select(
      (.id | type) == "string" and
      (.name | type) == "string" and
      (.local_path | type) == "string" and
      ($source_prefix == "" or (.local_path | startswith($source_prefix)))
    ))
  | sort_by(.local_path, .created_at)
  | group_by(.local_path)
  | map(last)
  | .[]
  | [.id, .name, .local_path, .created_at]
  | @tsv
' "$ACCOUNTS_FILE" > "$PROJECTS_FILE"

MANIFEST="$STAGING/manifest.tsv"
printf 'project_id\tname\toriginal_path\tcreated_at\tstatus\n' > "$MANIFEST"
MATERIALIZED=0
MISSING=0
while IFS=$'\t' read -r PROJECT_ID PROJECT_NAME ORIGINAL_PATH CREATED_AT; do
  SOURCE="$WORKSPACES_DIR/$PROJECT_ID"
  if [ ! -d "$SOURCE" ]; then
    printf '%s\t%s\t%s\t%s\tmissing-snapshot\n' "$PROJECT_ID" "$PROJECT_NAME" "$ORIGINAL_PATH" "$CREATED_AT" >> "$MANIFEST"
    MISSING=$((MISSING + 1))
    continue
  fi
  TARGET="$STAGING/repos/$PROJECT_ID"
  mkdir -p "$TARGET"
  if ! cp -al "$SOURCE/." "$TARGET/" 2>/dev/null; then
    cp -a "$SOURCE/." "$TARGET/"
  fi
  mkdir -p "$TARGET/.git"
  printf '%s\t%s\t%s\t%s\tmaterialized\n' "$PROJECT_ID" "$PROJECT_NAME" "$ORIGINAL_PATH" "$CREATED_AT" >> "$MANIFEST"
  MATERIALIZED=$((MATERIALIZED + 1))
done < "$PROJECTS_FILE"

rm "$PROJECTS_FILE"
find "$STAGING" -type d -exec chmod a+rx {} +
mv "$STAGING" "$DESTINATION"
STAGING=""
trap - EXIT
printf 'materialized=%s missing=%s destination=%s\n' "$MATERIALIZED" "$MISSING" "$DESTINATION"
