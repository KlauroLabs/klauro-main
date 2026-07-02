FROM golang:1.21 as builder
WORKDIR /src
COPY . .
RUN go build -o /out/server ./cmd/server

FROM gcr.io/distroless/base-debian12
COPY --from=builder /out/server /server
ENTRYPOINT ["/server"]
