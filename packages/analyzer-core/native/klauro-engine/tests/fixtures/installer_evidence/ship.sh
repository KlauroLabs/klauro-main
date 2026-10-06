#!/bin/sh
cargo build --release -p app -p helper
cp target/release/app /usr/local/bin/app
cp target/release/helper /usr/local/bin/helper
