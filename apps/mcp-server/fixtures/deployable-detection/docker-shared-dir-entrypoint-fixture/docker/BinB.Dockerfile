# Sibling per-service Dockerfile in the same shared docker/ directory,
# with its own direct entrypoint (no wrapper). Must resolve to binb, not be
# swept into bina's identity despite living in the same folder.
FROM rust:1.76 AS builder
WORKDIR /src
COPY . .
RUN cargo build --release -p binb

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/binb /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/binb"]
