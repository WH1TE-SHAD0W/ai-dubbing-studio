package media

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
)

// InputPath picks the WAV for a language: dir/in/{lang}.wav, else dir/in/input.wav.
func InputPath(dir, lang string) (string, error) {
	for _, name := range []string{lang + ".wav", "input.wav"} {
		p := filepath.Join(dir, "in", name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("media: no input WAV: put %s or %s in %s", lang+".wav", "input.wav", filepath.Join(dir, "in"))
}

// OutputPath is dir/out/{sessionId}-{lang}-{workerId}.wav. The worker id keeps
// a fenced old owner and the new owner from writing the same file.
func OutputPath(dir, sessionID, lang, workerID string) string {
	return filepath.Join(dir, "out", fmt.Sprintf("%s-%s-%s.wav", sessionID, lang, workerID))
}

// WAVSource streams a 16 kHz mono WAV in real time, one 20 ms frame per tick,
// then silence until the job ends (the host just stopped talking).
type WAVSource struct {
	pcm []byte
}

// NewWAVSource loads the WAV at path.
func NewWAVSource(path string) (*WAVSource, error) {
	pcm, err := audio.ReadPCM16Mono(path, audio.InRate)
	if err != nil {
		return nil, fmt.Errorf("media: %w", err)
	}
	return &WAVSource{pcm: pcm}, nil
}

// Run implements Source.
func (s *WAVSource) Run(ctx context.Context, onFrame func([]byte)) error {
	frame := audio.Bytes(audio.InRate, audio.FrameDuration)
	silence := make([]byte, frame)
	t := time.NewTicker(audio.FrameDuration)
	defer t.Stop()
	for pos := 0; ; pos += frame {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		if pos < len(s.pcm) {
			f := make([]byte, frame)
			copy(f, s.pcm[pos:min(pos+frame, len(s.pcm))])
			onFrame(f)
		} else {
			onFrame(silence)
		}
	}
}

// Close implements Source. A WAV source holds nothing open.
func (s *WAVSource) Close() error { return nil }

// WAVSink writes translated audio to a WAV file at real-time pace: once the
// first audio arrives, every 20 ms it writes 20 ms of audio, or silence when
// nothing is queued, so the file lines up with wall-clock time.
type WAVSink struct {
	buf     *audio.ByteBuffer
	w       *audio.WAVWriter
	mu      sync.Mutex
	started bool
	closed  bool
}

// NewWAVSink creates the output file (and its folder).
func NewWAVSink(path string, maxBuffer time.Duration) (*WAVSink, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, fmt.Errorf("media: %w", err)
	}
	w, err := audio.CreateWAV(path, audio.OutRate)
	if err != nil {
		return nil, fmt.Errorf("media: %w", err)
	}
	return &WAVSink{buf: audio.NewByteBuffer(audio.Bytes(audio.OutRate, maxBuffer)), w: w}, nil
}

// Enqueue implements Sink.
func (s *WAVSink) Enqueue(pcm []byte) {
	s.buf.Write(pcm)
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
}

// Clear implements Sink.
func (s *WAVSink) Clear() { s.buf.Reset() }

// Buffered implements Sink.
func (s *WAVSink) Buffered() time.Duration { return audio.Duration(audio.OutRate, s.buf.Len()) }

// Dropped returns how many bytes were dropped because the buffer was full.
func (s *WAVSink) Dropped() uint64 { return s.buf.Dropped() }

// Run implements Sink.
func (s *WAVSink) Run(ctx context.Context) error {
	frame := audio.Bytes(audio.OutRate, audio.FrameDuration)
	t := time.NewTicker(audio.FrameDuration)
	defer t.Stop()
	flush := time.NewTicker(5 * time.Second)
	defer flush.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-flush.C:
			s.mu.Lock()
			err := s.flushLocked()
			s.mu.Unlock()
			if err != nil {
				return err
			}
		case <-t.C:
			if err := s.tick(frame); err != nil {
				return err
			}
		}
	}
}

func (s *WAVSink) tick(frame int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started || s.closed {
		return nil
	}
	out := s.buf.Read(frame)
	if len(out) < frame {
		out = append(out, make([]byte, frame-len(out))...)
	}
	if _, err := s.w.Write(out); err != nil {
		return fmt.Errorf("media: write: %w", err)
	}
	return nil
}

func (s *WAVSink) flushLocked() error {
	if s.closed {
		return nil
	}
	if err := s.w.Flush(); err != nil {
		return fmt.Errorf("media: flush: %w", err)
	}
	return nil
}

// Close implements Sink. Audio still queued is written out first.
func (s *WAVSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if rest := s.buf.Read(s.buf.Len()); len(rest) > 0 {
		if _, err := s.w.Write(rest); err != nil {
			s.w.Close()
			return err
		}
	}
	return s.w.Close()
}
