#!/usr/bin/env bash
#
# Extracted so this gate has a name and can be unit-tested in isolation
# (see verify-distribution-channel.test.mjs). Source this file, then call
# verify_distribution_channel "$HOSTED" "$VERSION" "$TARBALL_CODE".
#
# Each condition is checked independently — do NOT combine into a single
# `[ A ] && [ B ] || [ C ]` expression. That shape groups as `(A && B) || C`,
# so a bare `[ "$TARBALL_CODE" = "206" ]` as the trailing `C` short-circuits
# the WHOLE check to "pass" whenever the tarball merely returns 206 —
# regardless of whether the hosted manifest version actually matches. That
# is exactly the stale-manifest failure this gate exists to catch, and it
# must FAIL LOUD (exit 1), not just print a warning and continue — a gate
# that can report OK on a wrong version is worse than no gate. Only an exact
# 200 + exact version match is a pass; 206 (or any other non-200) fails the
# gate just like a version mismatch.
verify_distribution_channel() {
  local hosted="$1" version="$2" tarball_code="$3"
  local version_ok=0 tarball_ok=0
  [ "$hosted" = "$version" ] && version_ok=1
  [ "$tarball_code" = "200" ] && tarball_ok=1
  if [ "$version_ok" = "1" ] && [ "$tarball_ok" = "1" ]; then
    return 0
  fi
  return 1
}
