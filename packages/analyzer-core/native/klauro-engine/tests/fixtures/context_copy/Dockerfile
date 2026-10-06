FROM rust:1.76 AS builder
WORKDIR /src
COPY . .
RUN cargo build --release -p svc

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/svc /usr/local/bin/svc
ENTRYPOINT ["/usr/local/bin/svc"]
