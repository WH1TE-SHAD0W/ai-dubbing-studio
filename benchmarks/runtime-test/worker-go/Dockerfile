# syntax=docker/dockerfile:1
#
# Go spike worker (ADR-0019). Build from benchmarks/runtime-test/worker-go:
#
#   docker build -t ads-spike-worker-go .
#
# cgo is required: LiveKit's media package encodes Opus with libopus and resamples
# with libsoxr. The nolibopusfile tag leaves out Opus file decoding, which a worker
# doesn't use, so libopusfile isn't needed at runtime.
ARG GO_VERSION=1.27

FROM golang:${GO_VERSION}-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libopus-dev libsoxr-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go vet -tags nolibopusfile ./... \
 && CGO_ENABLED=1 go build -tags nolibopusfile -trimpath -ldflags="-s -w" -o /out/worker .

# Runtime: the binary and the two shared libraries it links against, nothing else.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus0 libsoxr0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/worker /usr/local/bin/worker
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/worker"]
