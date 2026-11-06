# The translator worker (ADR-0019): a static Go binary on a distroless image.
# Build from apps/translator: docker build -t ai-dubbing-studio-translator apps/translator
# The control API types are generated and committed, so the build needs only this folder.

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# No cgo yet: Gemini and Redis are pure Go. Revisit when the LiveKit adapter
# needs libopus (pod-spec §13).
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/translator ./cmd/translator

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/translator /translator
# Probes only; work arrives through the Redis Stream.
EXPOSE 8080
ENV MEDIA_DIR=/media
USER nonroot:nonroot
ENTRYPOINT ["/translator"]
