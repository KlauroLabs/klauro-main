#!/usr/bin/env bash
# Packages client + client-service into a single installer artifact.
set -euo pipefail
cargo build --release -p client -p client-service
mkdir -p dist/installer
cp target/release/client dist/installer/
cp target/release/client-service dist/installer/
tar -czf dist/client-installer.tar.gz -C dist/installer .
