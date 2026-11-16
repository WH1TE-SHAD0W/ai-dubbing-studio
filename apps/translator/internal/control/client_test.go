package control_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
	fake "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/control"
)

func setup(t *testing.T, worker string) (*fake.Store, *control.Client) {
	t.Helper()
	store := fake.NewStore("secret")
	srv := httptest.NewServer(store.Handler())
	t.Cleanup(srv.Close)
	c, err := control.New(srv.URL, "secret", worker)
	if err != nil {
		t.Fatal(err)
	}
	return store, c
}

func TestClaimHeartbeatStatusRelease(t *testing.T) {
	store, c := setup(t, "w1")
	store.AddTrack("t1", "s1", "sk")
	ctx := context.Background()

	claim, err := c.Claim(ctx, "t1", "j1")
	if err != nil {
		t.Fatal(err)
	}
	if claim.SessionId != "s1" || claim.Language != "sk" || claim.LeaseTtlSec != 15 || claim.HeartbeatSec != 5 {
		t.Fatalf("claim %+v", claim)
	}
	// A retried claim by the same worker succeeds (the response may have been lost).
	if _, err := c.Claim(ctx, "t1", "j1"); err != nil {
		t.Fatalf("retried claim: %v", err)
	}
	ttl, err := c.Heartbeat(ctx, "t1", control.Heartbeat{State: api.WorkerStateLive, Reconnects: 2})
	if err != nil || ttl != 15*time.Second {
		t.Fatalf("heartbeat = %v, %v", ttl, err)
	}
	if err := c.Status(ctx, "t1", api.TrackStatusLive, ""); err != nil {
		t.Fatal(err)
	}
	if err := c.Release(ctx, "t1", api.Sigterm); err != nil {
		t.Fatal(err)
	}
	if got := store.Get("t1"); got.Status != "pending" || got.Owner != "" {
		t.Fatalf("after release: %+v", got)
	}
	hb := store.Calls()[2]
	if hb.Op != "heartbeat" || hb.Body["state"] != "live" || hb.Body["stats"].(map[string]any)["geminiReconnects"] != 2.0 {
		t.Fatalf("heartbeat body %+v", hb.Body)
	}
}

func TestConflictsMapToTypedErrors(t *testing.T) {
	store, w1 := setup(t, "w1")
	store.AddTrack("t1", "s1", "sk")
	ctx := context.Background()
	if _, err := w1.Claim(ctx, "nope", "j"); !errors.Is(err, control.ErrUnknownTrack) {
		t.Fatalf("unknown track: %v", err)
	}
	if _, err := w1.Claim(ctx, "t1", "j"); err != nil {
		t.Fatal(err)
	}
	store.Steal("t1", "w2")
	if _, err := w1.Heartbeat(ctx, "t1", control.Heartbeat{State: api.WorkerStateLive}); !errors.Is(err, control.ErrNotOwner) {
		t.Fatalf("stolen track heartbeat: %v", err)
	}
	store.End("t1")
	if _, err := w1.Heartbeat(ctx, "t1", control.Heartbeat{State: api.WorkerStateLive}); !errors.Is(err, control.ErrEnded) {
		t.Fatalf("ended track heartbeat: %v", err)
	}
	if _, err := w1.Claim(ctx, "t1", "j"); !errors.Is(err, control.ErrEnded) || !control.IsConflict(err) {
		t.Fatalf("claim of ended track: %v", err)
	}
}

func TestServerErrorsAreRetriedButClientErrorsAreNot(t *testing.T) {
	store, c := setup(t, "w1")
	store.AddTrack("t1", "s1", "sk")
	store.FailNext("claim", 2)
	if _, err := c.Claim(context.Background(), "t1", "j1"); err != nil {
		t.Fatalf("claim after two 500s: %v", err)
	}
	if n := len(store.Calls()); n != 3 {
		t.Fatalf("%d claim attempts, want 3", n)
	}

	store.FailNext("heartbeat", 1)
	if _, err := c.Heartbeat(context.Background(), "t1", control.Heartbeat{State: api.WorkerStateLive}); err == nil || control.IsConflict(err) {
		t.Fatalf("heartbeat 500 should fail once without retry: %v", err)
	}

	srv := httptest.NewServer(store.Handler())
	defer srv.Close()
	bad, _ := control.New(srv.URL, "wrong", "w1")
	before := len(store.Calls())
	if _, err := bad.Claim(context.Background(), "t1", "j1"); err == nil {
		t.Fatal("wrong token accepted")
	}
	if len(store.Calls()) != before {
		t.Fatal("401 reached the store")
	}
}

func TestSendsBearerTokenAndJSON(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c, _ := control.New(srv.URL+"/", "tok", "w1")
	if err := c.Status(context.Background(), "t 1", api.TrackStatusLive, ""); err != nil {
		t.Fatal(err)
	}
	if got.Get("Authorization") != "Bearer tok" || got.Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", got)
	}
}
