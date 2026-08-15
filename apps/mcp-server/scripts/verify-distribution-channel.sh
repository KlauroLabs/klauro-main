#!/usr/bin/env bash
verify_distribution_channel() {
  local hosted="$1" version="$2" tarball_code="$3"
  local version_ok=0 tarball_ok=0
  [ "$hosted" = "$version" ] && version_ok=1
  { [ "$tarball_code" = "200" ] || [ "$tarball_code" = "206" ]; } && tarball_ok=1
  if [ "$version_ok" = "1" ] && [ "$tarball_ok" = "1" ]; then
    return 0
  fi
  return 1
}
