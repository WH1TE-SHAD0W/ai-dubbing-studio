// Package media is where host audio comes from and translated audio goes.
// Two adapters implement it: LiveKit rooms (internal/livekit, ADR-0020) and
// WAV files, used when Hono sends no LiveKit access (local runs).
package media

import (
	"context"
	"errors"
	"time"
)

// Errors a Source or Sink returns from Run when its room ends it. The runner
// maps them to how the job stops.
var (
	// ErrRoomClosed: the room was deleted or the server removed us. Hono
	// deletes the source room when the session ends (ADR-0020).
	ErrRoomClosed = errors.New("media: the room was closed")
	// ErrReplaced: another participant joined with our identity, so another
	// worker owns the track now (fencing, ADR-0018).
	ErrReplaced = errors.New("media: another participant took this identity")
)

// Source delivers the host's audio as 20 ms frames of PCM16 mono 16 kHz.
type Source interface {
	// Run calls onFrame for every frame until ctx ends (returns nil) or the
	// source fails. onFrame must not block.
	Run(ctx context.Context, onFrame func(frame []byte)) error
	// Close releases the input (for LiveKit: leaves the source room).
	Close() error
}

// Sink plays translated PCM16 mono 24 kHz audio at real-time pace.
type Sink interface {
	// Run paces queued audio out until ctx ends.
	Run(ctx context.Context) error
	// Enqueue queues audio; it never blocks (the oldest audio is dropped when full).
	Enqueue(pcm []byte)
	// Clear drops queued audio (Gemini reported an interruption).
	Clear()
	// Buffered returns how much audio is queued.
	Buffered() time.Duration
	// Close finishes the output (for a WAV file: writes the final header; for
	// LiveKit: leaves the output room).
	Close() error
}
