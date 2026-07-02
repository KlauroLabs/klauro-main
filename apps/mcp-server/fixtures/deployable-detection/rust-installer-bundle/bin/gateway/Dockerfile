# Gateway ships independently with its own Dockerfile.
FROM rust:1.76 as builder
WORKDIR /src
COPY . .
RUN cargo build --release -p gateway

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/gateway /usr/local/bin/gateway
ENTRYPOINT ["/usr/local/bin/gateway"]
