// Package media provides in-memory media for tests.
package media

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
)

// Source emits a 20 ms frame of silence (or Frame, if set) every 20 ms.
type Source struct {
	// FailAfter makes Run fail after this long (0 = never).
	FailAfter time.Duration
	// FailWith is the error Run returns after FailAfter (default: a generic one).
	FailWith error
	closed   atomic.Bool
}

// Close implements media.Source.
func (s *Source) Close() error {
	s.closed.Store(true)
	return nil
}

// Closed reports whether Close was called.
func (s *Source) Closed() bool { return s.closed.Load() }

// Run implements media.Source.
func (s *Source) Run(ctx context.Context, onFrame func([]byte)) error {
	frame := make([]byte, audio.Bytes(audio.InRate, audio.FrameDuration))
	t := time.NewTicker(audio.FrameDuration)
	defer t.Stop()
	var fail <-chan time.Time
	if s.FailAfter > 0 {
		fail = time.After(s.FailAfter)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-fail:
			if s.FailWith != nil {
				return s.FailWith
			}
			return errors.New("fake source: failed")
		case <-t.C:
			onFrame(frame)
		}
	}
}

// Sink collects translated audio without pacing.
type Sink struct {
	mu      sync.Mutex
	got     []byte
	clears  int
	closed  bool
	running bool
}

// Run implements media.Sink.
func (s *Sink) Run(ctx context.Context) error {
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()
	<-ctx.Done()
	return nil
}

// Enqueue implements media.Sink.
func (s *Sink) Enqueue(pcm []byte) {
	s.mu.Lock()
	s.got = append(s.got, pcm...)
	s.mu.Unlock()
}

// Clear implements media.Sink.
func (s *Sink) Clear() {
	s.mu.Lock()
	s.clears++
	s.mu.Unlock()
}

// Buffered implements media.Sink.
func (s *Sink) Buffered() time.Duration { return 0 }

// Close implements media.Sink.
func (s *Sink) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

// Bytes returns how much audio arrived.
func (s *Sink) Bytes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.got)
}

// Closed reports whether Close was called.
func (s *Sink) Closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Clears returns how often Clear was called.
func (s *Sink) Clears() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clears
}
