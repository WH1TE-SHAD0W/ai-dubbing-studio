// Package control is an in-memory stand-in for Hono's internal translator
// API, following the same rules as the real one (claim, lease, owner check,
// ended). Serve it over HTTP with Handler (exercises the real client), or use
// Direct in tests that run on a fake clock.
package control

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	realcontrol "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
)

// Track is one fake track row.
type Track struct {
	SessionID  string
	Language   string
	Status     string // pending | claimed | live | ended | failed
	Owner      string
	LeaseUntil time.Time
	Reason     string
}

// Call is one recorded request.
type Call struct {
	Op       string
	TrackID  string
	WorkerID string
	Body     map[string]any
}

// Store holds the fake state.
type Store struct {
	mu        sync.Mutex
	tracks    map[string]*Track
	calls     []Call
	failNext  map[string]int // op → number of 500s to return
	Token     string
	LeaseTTL  time.Duration
	Heartbeat time.Duration
	// OnRelease and OnFailed are called (without the lock) when a track goes
	// back to pending, as Hono would re-enqueue it.
	OnRelease func(trackID string)
}

// NewStore returns an empty store with a 15 s lease and 5 s heartbeat.
func NewStore(token string) *Store {
	return &Store{tracks: map[string]*Track{}, failNext: map[string]int{}, Token: token, LeaseTTL: 15 * time.Second, Heartbeat: 5 * time.Second}
}

// AddTrack adds a pending track of a live session.
func (s *Store) AddTrack(trackID, sessionID, lang string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tracks[trackID] = &Track{SessionID: sessionID, Language: lang, Status: "pending"}
}

// End marks the track ended (the host ended the session). The owner is kept,
// so its next heartbeat gets 409 ended.
func (s *Store) End(trackID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.tracks[trackID]; t != nil {
		t.Status, t.LeaseUntil, t.Reason = "ended", time.Time{}, "session_ended"
	}
}

// Steal gives the track to another worker (simulates a reclaim after a partition).
func (s *Store) Steal(trackID, worker string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.tracks[trackID]; t != nil {
		t.Owner, t.Status, t.LeaseUntil = worker, "claimed", time.Now().Add(s.LeaseTTL)
	}
}

// FailNext makes the next n calls of op ("claim", "heartbeat", ...) return 500.
func (s *Store) FailNext(op string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failNext[op] = n
}

// Get returns a copy of a track.
func (s *Store) Get(trackID string) Track {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.tracks[trackID]; t != nil {
		return *t
	}
	return Track{}
}

// Calls returns the recorded calls.
func (s *Store) Calls() []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Call(nil), s.calls...)
}

// Ops returns the recorded operation names in order.
func (s *Store) Ops() []string {
	var out []string
	for _, c := range s.Calls() {
		out = append(out, c.Op)
	}
	return out
}

// result of one operation: HTTP status and body.
type result struct {
	status int
	body   any
}

func conflict(reason string) result {
	return result{http.StatusConflict, map[string]string{"reason": reason}}
}

var ok = result{http.StatusOK, api.Ok{Ok: api.True}}

// do applies one operation with Hono's rules.
func (s *Store) do(op, trackID, worker string, body map[string]any) result {
	s.mu.Lock()
	s.calls = append(s.calls, Call{Op: op, TrackID: trackID, WorkerID: worker, Body: body})
	if n := s.failNext[op]; n > 0 {
		s.failNext[op] = n - 1
		s.mu.Unlock()
		return result{http.StatusInternalServerError, map[string]string{"message": "injected failure"}}
	}
	t := s.tracks[trackID]
	now := time.Now()
	var res result
	var released bool
	switch {
	case t == nil && op == "claim":
		res = conflict("unknown_track")
	case t == nil:
		res = conflict("not_owner")
	case op == "claim":
		switch {
		case t.Status == "ended" || t.Status == "failed":
			res = conflict("ended")
		case t.Status == "pending" || t.Owner == worker || ((t.Status == "claimed" || t.Status == "live") && now.After(t.LeaseUntil)):
			if t.Owner != worker {
				t.Status = "claimed"
			}
			t.Owner, t.LeaseUntil = worker, now.Add(s.LeaseTTL)
			res = result{http.StatusOK, api.ClaimResponse{
				TrackId: trackID, SessionId: t.SessionID, Language: t.Language,
				LeaseTtlSec: int(s.LeaseTTL / time.Second), HeartbeatSec: int(s.Heartbeat / time.Second),
			}}
		default:
			res = conflict("owned")
		}
	case t.Status == "ended" || t.Status == "failed":
		// Checked before the owner, so a retried final call reads "ended".
		if t.Owner == worker && op == "status" && (body["status"] == "ended" || body["status"] == "failed") {
			res = ok
		} else {
			res = conflict("ended")
		}
	case t.Owner != worker:
		res = conflict("not_owner")
	case op == "heartbeat":
		t.LeaseUntil = now.Add(s.LeaseTTL)
		res = result{http.StatusOK, api.HeartbeatResponse{LeaseTtlSec: int(s.LeaseTTL / time.Second)}}
	case op == "status":
		switch body["status"] {
		case "live":
			t.Status, t.LeaseUntil = "live", now.Add(s.LeaseTTL)
		case "ended":
			t.Status, t.LeaseUntil = "ended", time.Time{}
		case "failed":
			t.Status, t.Owner, t.LeaseUntil = "pending", "", time.Time{}
			released = true
		}
		if r, _ := body["reason"].(string); r != "" {
			t.Reason = r
		}
		res = ok
	case op == "release":
		t.Status, t.Owner, t.LeaseUntil = "pending", "", time.Time{}
		t.Reason, _ = body["reason"].(string)
		released = true
		res = ok
	default:
		res = result{http.StatusNotFound, map[string]string{"message": "Not found."}}
	}
	cb := s.OnRelease
	s.mu.Unlock()
	if released && cb != nil {
		cb(trackID)
	}
	return res
}

// Handler serves the store over the HTTP contract.
func (s *Store) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer "+s.Token {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "Unauthorized."})
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if r.Method != http.MethodPost || len(parts) != 4 || parts[0] != "internal" || parts[1] != "tracks" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "Not found."})
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "Invalid JSON."})
			return
		}
		worker, _ := body["workerId"].(string)
		res := s.do(parts[3], parts[2], worker, body)
		w.WriteHeader(res.status)
		_ = json.NewEncoder(w).Encode(res.body)
	})
}

// Direct returns a control.API for worker that calls the store in memory.
func (s *Store) Direct(worker string) realcontrol.API { return direct{s: s, worker: worker} }

type direct struct {
	s      *Store
	worker string
}

func toErr(res result) error {
	if res.status == http.StatusOK {
		return nil
	}
	if res.status == http.StatusConflict {
		reason := res.body.(map[string]string)["reason"]
		switch reason {
		case "owned":
			return realcontrol.ErrOwned
		case "ended":
			return realcontrol.ErrEnded
		case "unknown_track":
			return realcontrol.ErrUnknownTrack
		default:
			return realcontrol.ErrNotOwner
		}
	}
	return &httpError{res.status}
}

type httpError struct{ status int }

func (e *httpError) Error() string { return "fake control: HTTP " + http.StatusText(e.status) }

func (d direct) Claim(_ context.Context, trackID, jobID string) (realcontrol.Claim, error) {
	res := d.s.do("claim", trackID, d.worker, map[string]any{"workerId": d.worker, "jobId": jobID})
	if err := toErr(res); err != nil {
		return realcontrol.Claim{}, err
	}
	return res.body.(api.ClaimResponse), nil
}

func (d direct) Heartbeat(_ context.Context, trackID string, hb realcontrol.Heartbeat) (time.Duration, error) {
	res := d.s.do("heartbeat", trackID, d.worker, map[string]any{"workerId": d.worker, "state": string(hb.State)})
	if err := toErr(res); err != nil {
		return 0, err
	}
	return time.Duration(res.body.(api.HeartbeatResponse).LeaseTtlSec) * time.Second, nil
}

func (d direct) Status(_ context.Context, trackID string, status api.TrackStatus, reason string) error {
	return toErr(d.s.do("status", trackID, d.worker, map[string]any{"workerId": d.worker, "status": string(status), "reason": reason}))
}

func (d direct) Release(_ context.Context, trackID string, reason api.ReleaseReason) error {
	return toErr(d.s.do("release", trackID, d.worker, map[string]any{"workerId": d.worker, "reason": string(reason)}))
}
