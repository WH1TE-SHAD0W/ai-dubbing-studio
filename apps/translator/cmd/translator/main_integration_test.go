//go:build integration

// Integration test: the whole worker (main's run) against a real Redis, the
// fake control API over HTTP and a fake Gemini, with WAV files on disk.
//
//	docker compose up -d redis
//	REDIS_URL=redis://localhost:6379 go test -tags integration ./cmd/translator/
package main

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/config"
	fakecontrol "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/control"
	fakegemini "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/gemini"
)

type harness struct {
	store  *fakecontrol.Store
	rdb    *redis.Client
	cfg    config.Config
	media  string
	stream string
	code   chan int
	cancel context.CancelFunc
}

func setup(t *testing.T) *harness {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("set REDIS_URL to run the integration test")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{store: fakecontrol.NewStore("it-token"), rdb: redis.NewClient(opts), code: make(chan int, 1)}
	t.Cleanup(func() { h.rdb.Close() })
	h.stream = fmt.Sprintf("it:jobs:%d", rand.Int64())
	t.Cleanup(func() { h.rdb.Del(context.Background(), h.stream) })

	srv := httptest.NewServer(h.store.Handler())
	t.Cleanup(srv.Close)

	h.media = t.TempDir()
	os.MkdirAll(filepath.Join(h.media, "in"), 0o755)
	os.WriteFile(filepath.Join(h.media, "in", "input.wav"), audio.EncodeWAV(make([]byte, audio.Bytes(audio.InRate, time.Second)), audio.InRate), 0o644)

	env := map[string]string{
		"REDIS_URL":          url,
		"JOB_STREAM":         h.stream,
		"CONTROL_API_URL":    srv.URL,
		"INTERNAL_API_TOKEN": "it-token",
		"GEMINI_API_KEY":     "unused",
		"MEDIA_DIR":          h.media,
		"WORKER_ID":          "it-worker",
		"HTTP_ADDR":          "127.0.0.1:0",
	}
	h.cfg, err = config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *harness) start(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	t.Cleanup(cancel)
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	go func() { h.code <- run(ctx, h.cfg, log, fakegemini.NewConnector()) }()
}

func (h *harness) enqueue(t *testing.T, trackID string) {
	t.Helper()
	err := h.rdb.XAdd(context.Background(), &redis.XAddArgs{Stream: h.stream, Values: map[string]any{
		"v": "1", "jobId": "job-" + trackID, "sessionId": "s1", "trackId": trackID, "language": "sk",
	}}).Err()
	if err != nil {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *harness) exitCode(t *testing.T, d time.Duration) int {
	t.Helper()
	select {
	case c := <-h.code:
		return c
	case <-time.After(d):
		t.Fatal("worker did not exit")
		return -1
	}
}

func (h *harness) consumers(t *testing.T) []redis.XInfoConsumer {
	t.Helper()
	c, err := h.rdb.XInfoConsumers(context.Background(), h.stream, "translators").Result()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestOneJobFromStreamToExit(t *testing.T) {
	h := setup(t)
	h.store.AddTrack("t1", "s1", "sk")
	h.enqueue(t, "t1")
	h.start(t)

	waitFor(t, "the track to go live", 10*time.Second, func() bool { return h.store.Get("t1").Status == "live" })
	time.Sleep(time.Second) // let some audio through

	h.store.End("t1") // the host ended the session: the next heartbeat gets 409 ended
	if code := h.exitCode(t, 10*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}

	if tr := h.store.Get("t1"); tr.Owner != "it-worker" || tr.Status != "ended" {
		t.Fatalf("track %+v", tr)
	}
	out := filepath.Join(h.media, "out", "s1-sk-it-worker.wav")
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	_, pcm, err := audio.DecodeWAV(b)
	if err != nil || len(pcm) == 0 {
		t.Fatalf("output WAV: %d bytes, %v", len(pcm), err)
	}
	if c := h.consumers(t); len(c) != 0 {
		t.Fatalf("consumer left behind: %+v", c)
	}
	pending, err := h.rdb.XPending(context.Background(), h.stream, "translators").Result()
	if err != nil || pending.Count != 0 {
		t.Fatalf("pending %+v, %v", pending, err)
	}
}

func TestRejectedClaimKeepsWaitingThenSigtermExits(t *testing.T) {
	h := setup(t)
	h.store.AddTrack("t1", "s1", "sk")
	h.store.Steal("t1", "someone-else")
	h.enqueue(t, "t1") // a duplicate job: the claim gets 409 owned
	h.start(t)

	waitFor(t, "the claim", 10*time.Second, func() bool { return len(h.store.Calls()) == 1 })
	time.Sleep(500 * time.Millisecond)
	select {
	case c := <-h.code:
		t.Fatalf("worker exited (%d) after a rejected claim; it should keep waiting", c)
	default:
	}
	pending, _ := h.rdb.XPending(context.Background(), h.stream, "translators").Result()
	if pending.Count != 0 {
		t.Fatalf("rejected job not acked: %+v", pending)
	}

	start := time.Now()
	h.cancel() // SIGTERM while idle
	if code := h.exitCode(t, 5*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("idle shutdown took %v: the blocking read should end on cancel", time.Since(start))
	}
}

func TestSigtermDuringJobReleasesTheTrack(t *testing.T) {
	h := setup(t)
	h.store.AddTrack("t1", "s1", "sk")
	h.enqueue(t, "t1")
	h.start(t)
	waitFor(t, "the track to go live", 10*time.Second, func() bool { return h.store.Get("t1").Status == "live" })

	h.cancel()
	if code := h.exitCode(t, 5*time.Second); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if tr := h.store.Get("t1"); tr.Status != "pending" || tr.Owner != "" || tr.Reason != "sigterm" {
		t.Fatalf("track %+v", tr)
	}
}
