# Top-level Dockerfile packaging client + client-service together
# (installer bundle). ENTRYPOINT is client — client is the primary shipped
# deployable; client-service is bundled into it.
FROM rust:1.76 as builder
WORKDIR /src
COPY . .
RUN cargo build --release -p client -p client-service

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/client /usr/local/bin/client
COPY --from=builder /src/target/release/client-service /usr/local/bin/client-service
COPY build-installer.sh /usr/local/bin/build-installer.sh
ENTRYPOINT ["/usr/local/bin/client"]
