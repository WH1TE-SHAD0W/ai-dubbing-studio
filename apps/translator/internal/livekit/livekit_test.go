package livekit

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	msdk "github.com/livekit/media-sdk"
	lkproto "github.com/livekit/protocol/livekit"
	"github.com/pion/webrtc/v4"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
)

func TestChunkerCutsFrames(t *testing.T) {
	c := chunker{size: 4}
	var got [][]byte
	emit := func(f []byte) { got = append(got, f) }
	c.write([]byte{1, 2, 3}, emit)
	if len(got) != 0 {
		t.Fatalf("emitted %d frames from 3 bytes", len(got))
	}
	c.write([]byte{4, 5, 6, 7, 8, 9}, emit)
	if len(got) != 2 || string(got[0]) != string([]byte{1, 2, 3, 4}) || string(got[1]) != string([]byte{5, 6, 7, 8}) {
		t.Fatalf("frames = %v", got)
	}
	if len(c.buf) != 1 || c.buf[0] != 9 {
		t.Fatalf("rest = %v", c.buf)
	}
}

func TestPCMRoundTrip(t *testing.T) {
	in := msdk.PCM16Sample{0, 1, -1, 32767, -32768}
	out := pcmSamples(pcmBytes(in))
	if len(out) != len(in) {
		t.Fatalf("len = %d", len(out))
	}
	for i := range in {
		if in[i] != out[i] {
			t.Fatalf("sample %d = %d, want %d", i, out[i], in[i])
		}
	}
}

func TestLeftErr(t *testing.T) {
	for _, c := range []struct {
		reason lkproto.DisconnectReason
		want   error
	}{
		{lkproto.DisconnectReason_ROOM_DELETED, media.ErrRoomClosed},
		{lkproto.DisconnectReason_ROOM_CLOSED, media.ErrRoomClosed},
		{lkproto.DisconnectReason_PARTICIPANT_REMOVED, media.ErrRoomClosed},
		{lkproto.DisconnectReason_DUPLICATE_IDENTITY, media.ErrReplaced},
	} {
		if err := leftErr(c.reason); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", c.reason, err, c.want)
		}
	}
	if err := leftErr(lkproto.DisconnectReason_CLIENT_INITIATED); err != nil {
		t.Errorf("leaving ourselves: %v", err)
	}
	err := leftErr(lkproto.DisconnectReason_SIGNAL_CLOSE)
	if err == nil || errors.Is(err, media.ErrRoomClosed) || errors.Is(err, media.ErrReplaced) {
		t.Errorf("signal close: %v", err)
	}
}

func TestWithoutTagIsUnavailable(t *testing.T) {
	if supported {
		t.Skip("built with the livekit tag")
	}
	if _, err := NewSource("ws://localhost:7880", "t", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("NewSource: %v", err)
	}
	if _, err := NewSink("ws://localhost:7880", "t", "sk", time.Second, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("NewSink: %v", err)
	}
}

// fakeTrack records what the sink writes.
type fakeTrack struct {
	webrtc.TrackLocal
	mu      sync.Mutex
	writes  []int // samples per write
	clears  int
	closed  bool
	failing error
}

func (f *fakeTrack) WriteSample(s msdk.PCM16Sample) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failing != nil {
		return f.failing
	}
	f.writes = append(f.writes, len(s))
	return nil
}

func (f *fakeTrack) ClearQueue() {
	f.mu.Lock()
	f.clears++
	f.mu.Unlock()
}

func (f *fakeTrack) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}

func (f *fakeTrack) snapshot() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.writes...)
}

func TestSinkPacesWithALead(t *testing.T) {
	tr := &fakeTrack{}
	s := newSink(tr, time.Second)
	frame := audio.Bytes(audio.OutRate, audio.FrameDuration)
	s.Enqueue(make([]byte, 5*frame))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()

	deadline := time.Now().Add(2 * time.Second)
	for s.Buffered() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	w := tr.snapshot()
	total := 0
	for _, n := range w {
		if n != frame/audio.BytesPerSample {
			t.Fatalf("write of %d samples, want %d", n, frame/audio.BytesPerSample)
		}
		total += n
	}
	if total != 5*frame/audio.BytesPerSample {
		t.Fatalf("wrote %d samples, want %d", total, 5*frame/audio.BytesPerSample)
	}
	// Five frames in four ticks: two on the first, then one per tick.
	if len(w) != 5 {
		t.Fatalf("writes = %v", w)
	}
}

func TestSinkClearDropsBothQueues(t *testing.T) {
	tr := &fakeTrack{}
	s := newSink(tr, time.Second)
	s.Enqueue(make([]byte, 4800))
	s.Clear()
	if s.Buffered() != 0 || tr.clears != 1 {
		t.Fatalf("buffered %v, track clears %d", s.Buffered(), tr.clears)
	}
}

func TestSinkStopsWhenTheRoomCloses(t *testing.T) {
	s := newSink(&fakeTrack{}, time.Second)
	s.room.onDisconnected() // no room: an unknown reason
	if err := s.Run(context.Background()); err == nil {
		t.Fatal("Run returned nil after the room went away")
	}
}

func TestSinkWriteErrorEndsRun(t *testing.T) {
	tr := &fakeTrack{failing: errors.New("track is closed")}
	s := newSink(tr, time.Second)
	s.Enqueue(make([]byte, 960))
	if err := s.Run(context.Background()); err == nil {
		t.Fatal("Run returned nil after a write error")
	}
}

func TestSinkCloseOnce(t *testing.T) {
	tr := &fakeTrack{}
	s := newSink(tr, time.Second)
	_ = s.Close()
	_ = s.Close()
	if !tr.closed {
		t.Fatal("track not closed")
	}
}

func TestSourceSendsSilenceWithoutTheHost(t *testing.T) {
	s := &Source{room: newRoom(), frames: chunker{size: audio.Bytes(audio.InRate, audio.FrameDuration)}}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var mu sync.Mutex
	n := 0
	if err := s.Run(ctx, func(f []byte) {
		mu.Lock()
		n++
		mu.Unlock()
		if len(f) != s.frames.size {
			t.Errorf("frame of %d bytes", len(f))
		}
	}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if n < 4 {
		t.Fatalf("%d silence frames in 150 ms", n)
	}
}

func TestSourceForwardsHostFramesAndHoldsSilence(t *testing.T) {
	s := &Source{room: newRoom(), frames: chunker{size: audio.Bytes(audio.InRate, audio.FrameDuration)}}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	var mu sync.Mutex
	var loud, quiet int
	go func() {
		// The host speaks after a pause: 10 ms decoded chunks.
		time.Sleep(60 * time.Millisecond)
		chunk := make(msdk.PCM16Sample, 160)
		for i := range chunk {
			chunk[i] = 1000
		}
		for range 40 {
			s.write(chunk)
			time.Sleep(4 * time.Millisecond)
		}
	}()
	_ = s.Run(ctx, func(f []byte) {
		mu.Lock()
		defer mu.Unlock()
		if f[0] == 0 && f[1] == 0 {
			quiet++
		} else {
			loud++
		}
	})
	if loud != 20 {
		t.Fatalf("host frames = %d, want 20 (40 chunks of 10 ms)", loud)
	}
	if quiet == 0 {
		t.Fatal("no silence before the host spoke")
	}
}

func TestSourceStopsWhenTheRoomCloses(t *testing.T) {
	s := &Source{room: newRoom(), frames: chunker{size: 640}}
	s.room.onDisconnected()
	if err := s.Run(context.Background(), func([]byte) {}); err == nil {
		t.Fatal("Run returned nil after the room went away")
	}
}
