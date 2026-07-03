#!/usr/bin/env bash
# Packages client + client-service into a single installer artifact. Mirrors
# the real zerac/poc build-mac-installer.sh pattern: the binary name is passed
# through a shell function parameter rather than written literally on the
# cargo line.
set -euo pipefail

build_binary() {
    local binary_name=$1
    cargo build --release -p "$binary_name"
    echo "target/release/$binary_name"
}

CLIENT_BINARY=$(build_binary "client")
SERVICE_BINARY=$(build_binary "client-service")

mkdir -p dist/installer
cp "$CLIENT_BINARY" dist/installer/
cp "$SERVICE_BINARY" dist/installer/
tar -czf dist/client-installer.tar.gz -C dist/installer .
