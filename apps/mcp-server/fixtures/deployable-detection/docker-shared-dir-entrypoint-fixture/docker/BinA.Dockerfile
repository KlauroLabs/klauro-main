# Per-service Dockerfile living in a SHARED directory (docker/) alongside
# BinB.Dockerfile. ENTRYPOINT is a generic wrapper script (not a real member),
# so the real shipped binary must be recovered from the sole build-output
# binary this Dockerfile actually compiles (bina) — reproduces the
# entrypoint-as-primary shape from the real repo (docker/Client.Dockerfile).
FROM rust:1.76 AS builder
WORKDIR /src
COPY . .
RUN cargo build --release -p bina

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/bina /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
