FROM golang:1.21 as builder
WORKDIR /src
COPY . .
RUN go build -o /out/worker ./cmd/worker

FROM gcr.io/distroless/base-debian12
COPY --from=builder /out/worker /worker
ENTRYPOINT ["/worker"]
