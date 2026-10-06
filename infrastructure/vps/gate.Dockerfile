# klauro-gate — a thin, small layer on top of the deployed api image, purpose-built
# to run the test suite against /opt/klauro/devgate (a full rsynced tree +
# `npm install --include=dev`) without the two environment artifacts that were
# polluting gate results when running the bare api image directly:
#
#   1. No git in the api image. Anything that shells out to git (several
#      tests do, e.g. tree provenance / dirty-check style checks) fails with
#      `spawnSync git ENOENT` instead of exercising real logic. This showed up
#      ~234 times in one full mcp-server suite run and had to be worked around
#      per-run with a slow `apt-get install git` inside the container.
#   2. The api image runs as root. Root can read/write anything, so any test
#      that asserts a permission-denied path (e.g. "permission-denied
#      subdirectories") can never actually trip — the assertion is
#      structurally unreachable under root, independent of whether the
#      underlying code is correct.
#
# BASE_IMAGE is a build ARG (not hardcoded) so this tracks whatever the api
# image happens to be after the next deploy — rebuild this on top of a fresh
# BASE_IMAGE after every deploy rather than letting it drift stale.
ARG BASE_IMAGE=klauro/api:alpha
FROM ${BASE_IMAGE}

ARG AST_GREP_VERSION=0.45.1
ARG CODEBASE_MEMORY_VERSION=0.11.0
ARG CODEBASE_MEMORY_SHA256=1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683
ARG SCIP_VERSION=0.9.0
ARG SCIP_SHA256=fc2e7273e110be9f35924da1066000183791e8bfdb0391355de6eaaa070fec75
ARG SCIP_TYPESCRIPT_VERSION=0.4.0

# git: required so git-shelling tests exercise real behavior instead of ENOENT.
# procps (ps): several suite helpers/benches shell out to `ps` to check for
#   stray child processes / kill leftover workers between test files; without
#   it those checks silently no-op instead of catching leaks.
# python3-pip: telemetry release proofs install the built wheel in an isolated
#   environment before accepting it as an installable SDK artifact.
# openssh-client: NOT installed — nothing in the gate needs outbound ssh from
#   inside the container (sync happens from the dev machine, see gate.sh),
#   and adding it would be gold-plating with no probe backing it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps python3-pip ripgrep universal-ctags \
  && npm install --global \
    "@ast-grep/cli@${AST_GREP_VERSION}" \
    "@sourcegraph/scip-typescript@${SCIP_TYPESCRIPT_VERSION}" \
  && curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CODEBASE_MEMORY_VERSION}/codebase-memory-mcp-linux-amd64-portable.tar.gz" -o /tmp/cbm.tar.gz \
  && echo "${CODEBASE_MEMORY_SHA256}  /tmp/cbm.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/cbm.tar.gz -C /usr/local/bin codebase-memory-mcp \
  && chmod 755 /usr/local/bin/codebase-memory-mcp \
  && rm -f /tmp/cbm.tar.gz \
  && codebase-memory-mcp --version \
  && curl -fsSL "https://github.com/scip-code/scip/releases/download/v${SCIP_VERSION}/scip-linux-amd64.tar.gz" -o /tmp/scip.tar.gz \
  && echo "${SCIP_SHA256}  /tmp/scip.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/scip.tar.gz -C /usr/local/bin scip \
  && chmod 755 /usr/local/bin/scip \
  && rm -f /tmp/scip.tar.gz \
  && rm -rf /var/lib/apt/lists/*

# Non-root user so permission-bit assertions in the suite (e.g.
# "permission-denied subdirectories") can actually fail the way they would
# for a real, non-privileged agent process — root bypasses every permission
# check and made that whole test class unreachable.
#
# node:22-bookworm-slim (the api image's base) already ships a uid-1000 user
# named `node` with a home dir — rename it to `gate` rather than creating a
# second uid-1000 account (useradd --uid 1000 fails with "UID 1000 is not
# unique" against that pre-existing user).
RUN usermod -l gate -d /home/gate -m node \
  && git config --system --add safe.directory '*' \
  && su gate -c "git config --global user.email 'gate@klauro.dev'" \
  && su gate -c "git config --global user.name 'Klauro Gate'" \
  && su gate -c "git config --global init.defaultBranch main"

# /gate is the devgate tree, bind-mounted at run time by gate.sh — chown here
# only covers the image's own writable dirs (gate's $HOME); the mount itself
# is owned by whatever rsync/npm left on the host, tests that need to write
# under /gate rely on the mounted tree already being group/world-writable
# (it is: rsynced as the devgate-sync user, not root-owned).
WORKDIR /gate
