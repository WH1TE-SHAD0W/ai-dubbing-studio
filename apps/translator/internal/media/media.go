// Package media is where host audio comes from and translated audio goes.
// The interfaces fit LiveKit (a subscribed host track in, a published track
// out); this phase ships a WAV file adapter so the job path runs end to end.
package media

import (
	"context"
	"time"
)

// Source delivers the host's audio as 20 ms frames of PCM16 mono 16 kHz.
type Source interface {
	// Run calls onFrame for every frame until ctx ends (returns nil) or the
	// source fails. onFrame must not block.
	Run(ctx context.Context, onFrame func(frame []byte)) error
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
	// Close finishes the output (for a WAV file: writes the final header).
	Close() error
}
