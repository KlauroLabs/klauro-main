#!/usr/bin/env bash
#
# Extracted so this gate has a name and can be unit-tested in isolation
# (see verify-distribution-channel.test.mjs). Source this file, then call
# verify_distribution_channel "$HOSTED" "$VERSION" "$TARBALL_CODE".
#
# Each condition is checked independently — do NOT combine into a single
# `[ A ] && [ B ] || [ C ]` expression. That shape groups as `(A && B) || C`,
# so the trailing status test short-circuits the WHOLE check to "pass"
# regardless of whether the hosted manifest version matches. That is exactly
# the stale-manifest failure this gate exists to catch, and it must FAIL LOUD
# (exit 1), not warn and continue — a gate that can report OK on a wrong
# version is worse than no gate.
#
# 200 AND 206 are both success: the caller probes with `curl -r 0-0`, and a
# server that honors the range header answers 206 Partial Content. Rejecting
# 206 would fail every correctly-served release. Any other status fails.
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
