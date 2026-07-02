# Server ships independently with its own Dockerfile.
FROM rust:1.76 as builder
WORKDIR /src
COPY . .
RUN cargo build --release -p server

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/server /usr/local/bin/server
ENTRYPOINT ["/usr/local/bin/server"]
