FROM golang:1.21 as builder
WORKDIR /src
COPY . .
RUN go build -o /out/cli ./cmd/cli

FROM gcr.io/distroless/base-debian12
COPY --from=builder /out/cli /cli
ENTRYPOINT ["/cli"]
