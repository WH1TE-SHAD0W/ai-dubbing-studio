package gemini_test

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	fake "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/gemini"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
)

// harness runs a manager fed with 20 ms frames, on synctest's fake clock.
type harness struct {
	conn      *fake.Connector
	m         *gemini.Manager
	got       atomic.Int64
	interrupt atomic.Int64
	live      atomic.Int64
	cancel    context.CancelFunc
	done      chan error
}

func start(t *testing.T, conn *fake.Connector) *harness {
	t.Helper()
	q := audio.NewFrameQueue(10)
	h := &harness{conn: conn, done: make(chan error, 1)}
	h.m = gemini.NewManager(conn, q, gemini.ManagerConfig{Lang: "sk"})
	h.m.OnAudio = func(pcm []byte, rate int) {
		if rate != audio.OutRate {
			t.Errorf("rate %d", rate)
		}
		h.got.Add(int64(len(pcm)))
	}
	h.m.OnInterrupted = func() { h.interrupt.Add(1) }
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go func() {
		tk := time.NewTicker(audio.FrameDuration)
		defer tk.Stop()
		frame := make([]byte, audio.Bytes(audio.InRate, audio.FrameDuration))
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				q.Push(frame)
			}
		}
	}()
	go func() { h.done <- h.m.Run(ctx, func() { h.live.Add(1) }) }()
	return h
}

func (h *harness) stop(t *testing.T) {
	t.Helper()
	h.cancel()
	if err := <-h.done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
}

func TestStreamsAudioBothWays(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, fake.NewConnector())
		time.Sleep(time.Second)
		synctest.Wait()
		if h.live.Load() != 1 || h.m.State() != gemini.StateLive {
			t.Fatalf("live=%d state=%v", h.live.Load(), h.m.State())
		}
		sent := 0
		for _, c := range h.conn.Last().Sent() {
			if len(c) != 3200 {
				t.Fatalf("chunk of %d bytes, want 3200 (100 ms)", len(c))
			}
			sent += len(c)
		}
		if sent < 8*3200 {
			t.Fatalf("sent %d bytes in 1 s", sent)
		}
		if got := h.got.Load(); got != int64(sent*3/2) {
			t.Fatalf("received %d bytes, want %d", got, sent*3/2)
		}
		h.stop(t)
		if !h.conn.Last().Closed() {
			t.Fatal("session left open after Run returned")
		}
	})
}

func TestGoAwayResumesWithHandleBeforeClosingTheOldStream(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, fake.NewConnector())
		time.Sleep(200 * time.Millisecond)
		first := h.conn.Last()
		first.Resumable("handle-1")
		first.GoAway(10 * time.Second)
		synctest.Wait()

		sessions := h.conn.Sessions()
		if len(sessions) != 2 || sessions[1].Handle != "handle-1" {
			t.Fatalf("sessions %d, handles %v", len(sessions), h.conn.Handles())
		}
		if first.Closed() {
			t.Fatal("old stream closed before the grace period (make-before-break)")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if !first.Closed() {
			t.Fatal("old stream still open after the grace period")
		}
		if len(sessions[1].Sent()) == 0 {
			t.Fatal("audio did not move to the new stream")
		}
		if h.m.Reconnects() != 1 || h.m.State() != gemini.StateLive {
			t.Fatalf("reconnects %d state %v", h.m.Reconnects(), h.m.State())
		}
		h.stop(t)
	})
}

func TestDroppedStreamReconnectsWithBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, fake.NewConnector())
		time.Sleep(100 * time.Millisecond)
		h.conn.Last().Resumable("h1")
		h.conn.Last().Fail(errors.New("connection reset"))
		synctest.Wait()
		// It lived under 10 s, so the reconnect waits the first backoff step.
		if n := len(h.conn.Sessions()); n != 1 || h.m.State() != gemini.StateReconnecting {
			t.Fatalf("sessions %d state %v right after the drop", n, h.m.State())
		}
		time.Sleep(600 * time.Millisecond)
		synctest.Wait()
		if n := len(h.conn.Sessions()); n != 2 || h.m.State() != gemini.StateLive {
			t.Fatalf("sessions %d state %v after backoff", n, h.m.State())
		}
		if got := h.conn.Handles(); !slices.Equal(got, []string{"", "h1"}) {
			t.Fatalf("handles %v, want resume with h1", got)
		}
		h.stop(t)
	})
}

func TestStaleHandleFallsBackToFreshSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, fake.NewConnector())
		time.Sleep(11 * time.Second) // stable: no extra delay
		h.conn.Last().Resumable("old")
		h.conn.FailNext(1, errors.New("invalid handle"))
		h.conn.Last().Fail(errors.New("closed"))
		time.Sleep(time.Second)
		synctest.Wait()
		if got := h.conn.Handles(); !slices.Equal(got, []string{"", "old", ""}) {
			t.Fatalf("handles %v", got)
		}
		if h.m.State() != gemini.StateLive {
			t.Fatalf("state %v", h.m.State())
		}
		h.stop(t)
	})
}

func TestRetriesExhausted(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		conn := fake.NewConnector()
		conn.FailNext(3, errors.New("unavailable"))
		h := start(t, conn)
		err := <-h.done
		if !errors.Is(err, gemini.ErrRetriesExhausted) {
			t.Fatalf("err %v", err)
		}
		if h.live.Load() != 0 {
			t.Fatal("onLive called without a stream")
		}
		h.cancel()
	})
}

func TestRepeatedShortSessionsExhaustTheBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		conn := fake.NewConnector()
		conn.OnConnect = func(s *fake.Session) {
			go func() {
				time.Sleep(time.Second)
				s.Fail(errors.New("dies young"))
			}()
		}
		h := start(t, conn)
		err := <-h.done
		if !errors.Is(err, gemini.ErrRetriesExhausted) {
			t.Fatalf("err %v", err)
		}
		if n := len(conn.Sessions()); n != 3 {
			t.Fatalf("%d sessions before giving up, want 3", n)
		}
		h.cancel()
	})
}

func TestStalledSendClosesTheStream(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		conn := fake.NewConnector()
		conn.BlockFirst = 1
		h := start(t, conn)
		time.Sleep(4 * time.Second)
		synctest.Wait()
		if conn.Sessions()[0].Closed() {
			t.Fatal("closed before the 5 s stall limit")
		}
		time.Sleep(3 * time.Second)
		synctest.Wait()
		if !conn.Sessions()[0].Closed() || len(conn.Sessions()) != 2 {
			t.Fatalf("stalled stream not replaced: closed=%v sessions=%d", conn.Sessions()[0].Closed(), len(conn.Sessions()))
		}
		h.stop(t)
	})
}

func TestInterruptedOnlyFromTheCurrentStream(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, fake.NewConnector())
		time.Sleep(100 * time.Millisecond)
		h.conn.Last().Push(gemini.Event{Interrupted: true})
		synctest.Wait()
		if h.interrupt.Load() != 1 {
			t.Fatalf("interruptions %d", h.interrupt.Load())
		}
		h.stop(t)
	})
}
