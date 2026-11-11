# The translator worker (ADR-0019).
# Build from apps/translator: docker build -t ai-dubbing-studio-translator apps/translator
# The control API types are generated and committed, so the build needs only this folder.
#
# cgo is required: the LiveKit adapter (YGP-70) encodes Opus with libopus and
# resamples with libsoxr. The livekit tag turns the adapter on; nolibopusfile
# leaves out Opus file decoding, which the worker doesn't use.

FROM golang:1.27-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libopus-dev libsoxr-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -tags livekit,nolibopusfile -trimpath -ldflags="-s -w" -o /out/translator ./cmd/translator

# Runtime: the binary and the two shared libraries it links against.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus0 libsoxr0 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /media && chown 65532:65532 /media
COPY --from=build /out/translator /translator
# Probes only; work arrives through the Redis Stream.
EXPOSE 8080
ENV MEDIA_DIR=/media
USER 65532:65532
ENTRYPOINT ["/translator"]
