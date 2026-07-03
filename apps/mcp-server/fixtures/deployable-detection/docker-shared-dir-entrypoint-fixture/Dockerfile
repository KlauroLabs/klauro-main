# Generic top-level dev/test image bundling everything for convenience,
# mirroring the real repo's docker-compose dev harness image. Must NOT win
# primary attribution over bina/binb's own dedicated per-service Dockerfiles
# under docker/ — those are more specific, real ship evidence.
FROM rust:1.76 AS builder
WORKDIR /src
COPY . .
RUN cargo build --release -p bina -p binb

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/bina /usr/local/bin/
COPY --from=builder /src/target/release/binb /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bina"]
