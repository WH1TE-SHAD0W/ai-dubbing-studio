// Package control is the worker's client for Hono's internal translator API
// (packages/contracts/openapi/translator-control.yaml).
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
)

// Typed conflicts. After a successful claim, ErrEnded and ErrNotOwner both
// mean "stop now".
var (
	ErrOwned        = errors.New("control: track is owned by another worker")
	ErrEnded        = errors.New("control: track or session ended")
	ErrUnknownTrack = errors.New("control: unknown track")
	ErrNotOwner     = errors.New("control: this worker no longer owns the track")
)

// Claim is a successful claim.
type Claim = api.ClaimResponse

// Heartbeat is the body of a heartbeat call, without the worker id.
type Heartbeat struct {
	State           api.WorkerState
	InDroppedFrames int
	OutBufferMs     int
	Reconnects      int
}

// API is what the runner needs from Hono. The fake in internal/fakes/control
// implements the same HTTP contract, so tests exercise this client too.
type API interface {
	Claim(ctx context.Context, trackID, jobID string) (Claim, error)
	Heartbeat(ctx context.Context, trackID string, hb Heartbeat) (leaseTTL time.Duration, err error)
	Status(ctx context.Context, trackID string, status api.TrackStatus, reason string) error
	Release(ctx context.Context, trackID string, reason api.ReleaseReason) error
}

// Client calls the internal API over HTTP.
type Client struct {
	base     *url.URL
	token    string
	workerID string
	http     *http.Client
	// Attempts and backoff for claim, status and release (3 attempts in under 3 s).
	attempts int
	backoff  []time.Duration
	// RequestTimeout bounds each attempt.
	requestTimeout time.Duration
}

// New returns a client. baseURL is Hono's internal base URL.
func New(baseURL, token, workerID string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("control: bad base URL %q", baseURL)
	}
	return &Client{
		base:           u,
		token:          token,
		workerID:       workerID,
		http:           &http.Client{},
		attempts:       3,
		backoff:        []time.Duration{200 * time.Millisecond, 600 * time.Millisecond},
		requestTimeout: 2 * time.Second,
	}, nil
}

// Claim takes ownership of a track. A retry after a lost response is safe:
// Hono treats a claim by the current owner as a success.
func (c *Client) Claim(ctx context.Context, trackID, jobID string) (Claim, error) {
	var out Claim
	err := c.call(ctx, true, trackID, "claim", api.ClaimRequest{WorkerId: c.workerID, JobId: jobID}, &out)
	return out, err
}

// Heartbeat extends the lease. It is not retried here: the runner sends the
// next one on its own schedule and tolerates misses up to the lease TTL.
func (c *Client) Heartbeat(ctx context.Context, trackID string, hb Heartbeat) (time.Duration, error) {
	body := api.HeartbeatRequest{
		WorkerId: c.workerID,
		State:    hb.State,
		Stats: &api.HeartbeatStats{
			InDroppedFrames:  &hb.InDroppedFrames,
			OutBufferMs:      &hb.OutBufferMs,
			GeminiReconnects: &hb.Reconnects,
		},
	}
	var out api.HeartbeatResponse
	if err := c.call(ctx, false, trackID, "heartbeat", body, &out); err != nil {
		return 0, err
	}
	return time.Duration(out.LeaseTtlSec) * time.Second, nil
}

// Status reports live, ended or failed.
func (c *Client) Status(ctx context.Context, trackID string, status api.TrackStatus, reason string) error {
	body := api.StatusRequest{WorkerId: c.workerID, Status: status}
	if reason != "" {
		body.Reason = &reason
	}
	return c.call(ctx, true, trackID, "status", body, nil)
}

// Release gives the track back so Hono re-enqueues it.
func (c *Client) Release(ctx context.Context, trackID string, reason api.ReleaseReason) error {
	return c.call(ctx, true, trackID, "release", api.ReleaseRequest{WorkerId: c.workerID, Reason: reason}, nil)
}

// call POSTs body to /internal/tracks/{trackID}/{op}. Network errors and 5xx
// are retried when retry is set; 4xx never are.
func (c *Client) call(ctx context.Context, retry bool, trackID, op string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	u := c.base.JoinPath("internal", "tracks", trackID, op)
	attempts := 1
	if retry {
		attempts = c.attempts
	}
	var last error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			wait := c.backoff[min(i-1, len(c.backoff)-1)]
			select {
			case <-ctx.Done():
				return errors.Join(last, context.Cause(ctx))
			case <-time.After(wait):
			}
		}
		var permanent bool
		permanent, last = c.once(ctx, u.String(), payload, out)
		if last == nil || permanent {
			return last
		}
	}
	return last
}

func (c *Client) once(ctx context.Context, u string, payload []byte, out any) (permanent bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return true, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("control %s: %w", req.URL.Path, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	switch {
	case res.StatusCode == http.StatusOK:
		if out != nil {
			if err := json.Unmarshal(data, out); err != nil {
				return true, fmt.Errorf("control %s: bad response: %w", req.URL.Path, err)
			}
		}
		return true, nil
	case res.StatusCode == http.StatusConflict:
		var conflict struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(data, &conflict)
		return true, conflictError(conflict.Reason)
	case res.StatusCode >= 500:
		return false, fmt.Errorf("control %s: %s", req.URL.Path, res.Status)
	default:
		return true, fmt.Errorf("control %s: %s: %s", req.URL.Path, res.Status, strings.TrimSpace(string(data)))
	}
}

func conflictError(reason string) error {
	switch reason {
	case string(api.ClaimConflictReasonOwned):
		return ErrOwned
	case string(api.ClaimConflictReasonEnded):
		return ErrEnded
	case string(api.ClaimConflictReasonUnknownTrack):
		return ErrUnknownTrack
	case string(api.OwnerConflictReasonNotOwner):
		return ErrNotOwner
	default:
		// An unknown reason is still a conflict: the safe reading is "not yours".
		return ErrNotOwner
	}
}

// IsConflict reports whether err is any 409 from the control API.
func IsConflict(err error) bool {
	return errors.Is(err, ErrOwned) || errors.Is(err, ErrEnded) || errors.Is(err, ErrUnknownTrack) || errors.Is(err, ErrNotOwner)
}
