// Package runner runs one translation job, from the claim to the last call
// to Hono. A worker process runs exactly one job and then exits (ADR-0018).
package runner

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/jobs"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
)

// State is the worker's lifecycle state (pod-spec §4.1).
type State int32

const (
	StateIdle State = iota
	StateClaiming
	StateConnecting
	StateLive
	StateReconnecting
	StateEnding
	StateFenced
	StateDraining
	StateFailing
	StateDone
)

var stateNames = [...]string{"idle", "claiming", "connecting", "live", "reconnecting", "ending", "fenced", "draining", "failing", "done"}

func (s State) String() string {
	if int(s) < len(stateNames) {
		return stateNames[s]
	}
	return "unknown"
}

// Busy reports whether the state is a claimed, running job.
func (s State) Busy() bool { return s == StateConnecting || s == StateLive || s == StateReconnecting }

// Outcome is how a job ended.
type Outcome string

const (
	// Rejected: the claim failed (409, or Hono unreachable). The worker never
	// owned the track and stays idle.
	Rejected Outcome = "rejected"
	// Ended: the session or track ended (heartbeat 409 ended, or the maximum length).
	Ended Outcome = "ended"
	// Fenced: another worker owns the track now, or the lease was lost.
	Fenced Outcome = "fenced"
	// Failed: the worker gave up and reported status failed.
	Failed Outcome = "failed"
	// Released: SIGTERM; the track was given back.
	Released Outcome = "released"
)

// Acker acknowledges stream messages.
type Acker interface {
	Ack(ctx context.Context, id string) error
}

// Deps are the runner's collaborators.
type Deps struct {
	Control control.API
	Queue   Acker
	Gemini  gemini.Connector
	// NewSource and NewSink open the media for a job.
	NewSource func(job *jobs.Job) (media.Source, error)
	NewSink   func(job *jobs.Job) (media.Sink, error)
	Log       *slog.Logger
}

// Options tune the runner. Zero values get the defaults.
type Options struct {
	MaxJob       time.Duration // default 240 min
	InBuffer     time.Duration // default 200 ms
	Gemini       gemini.ManagerConfig
	DrainTimeout time.Duration // default 500 ms
	WaitTimeout  time.Duration // default 2 s
	FinalTimeout time.Duration // default 3 s
	// LeaseMargin: with no successful heartbeat for leaseTTL minus this, the
	// worker assumes it lost the track. Default 3 s.
	LeaseMargin time.Duration
}

func (o *Options) defaults() {
	if o.MaxJob <= 0 {
		o.MaxJob = 240 * time.Minute
	}
	if o.InBuffer <= 0 {
		o.InBuffer = 200 * time.Millisecond
	}
	if o.DrainTimeout <= 0 {
		o.DrainTimeout = 500 * time.Millisecond
	}
	if o.WaitTimeout <= 0 {
		o.WaitTimeout = 2 * time.Second
	}
	if o.FinalTimeout <= 0 {
		o.FinalTimeout = 3 * time.Second
	}
	if o.LeaseMargin <= 0 {
		o.LeaseMargin = 3 * time.Second
	}
}

// Runner runs one job. Its state is read by the health endpoints.
type Runner struct {
	d     Deps
	o     Options
	state atomic.Int32
	// lastBeat is the UnixNano time of the last successful heartbeat (or the claim).
	lastBeat atomic.Int64
	leaseTTL atomic.Int64
}

// New returns a runner.
func New(d Deps, o Options) *Runner {
	o.defaults()
	if d.Log == nil {
		d.Log = slog.New(slog.DiscardHandler)
	}
	return &Runner{d: d, o: o}
}

// State returns the current state.
func (r *Runner) State() State { return State(r.state.Load()) }

// Healthy reports whether a busy runner is still doing its job: its lease
// is fresh. (Gemini giving up ends the job, so a busy runner with a fresh
// lease is either streaming or reconnecting within its retry budget.)
func (r *Runner) Healthy() bool {
	if !r.State().Busy() {
		return true
	}
	return time.Since(time.Unix(0, r.lastBeat.Load())) < time.Duration(r.leaseTTL.Load())
}

// cause is why a job stops.
type cause struct {
	outcome Outcome
	state   State
	reason  string
}

var (
	causeEnded   = cause{Ended, StateEnding, "ended"}
	causeFenced  = cause{Fenced, StateFenced, "not_owner"}
	causeSigterm = cause{Released, StateDraining, "sigterm"}
	causeMaxLen  = cause{Ended, StateEnding, "max_duration"}
)

func failed(reason string) cause { return cause{Failed, StateFailing, reason} }

// causeBox keeps the first stop cause, except that being fenced overrides
// everything: once another worker owns the track we must not call Hono.
type causeBox struct {
	mu  sync.Mutex
	c   *cause
	off context.CancelFunc
}

func (b *causeBox) set(c cause) {
	b.mu.Lock()
	if b.c == nil || c.outcome == Fenced {
		b.c = &c
	}
	b.mu.Unlock()
	b.off()
}

func (b *causeBox) get() cause {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.c == nil {
		return failed("unknown")
	}
	return *b.c
}

// Run processes one job. shutdown is cancelled on SIGTERM.
func (r *Runner) Run(shutdown context.Context, job *jobs.Job) Outcome {
	log := r.d.Log.With("jobId", job.JobId, "sessionId", job.SessionId, "trackId", job.TrackId, "language", job.Language)
	r.state.Store(int32(StateClaiming))

	// The claim finishes even if SIGTERM arrives meanwhile (it takes under 3 s),
	// so we know whether there is a track to give back.
	calm := context.WithoutCancel(shutdown)
	claimCtx, cancelClaim := context.WithTimeout(calm, 5*time.Second)
	claim, err := r.d.Control.Claim(claimCtx, job.TrackId, job.JobId)
	cancelClaim()
	// Ack after any answer: Postgres owns the track from here, Redis is done.
	if ackErr := r.d.Queue.Ack(calm, job.ID); ackErr != nil {
		log.Warn("ack failed", "error", ackErr.Error())
	}
	if err != nil {
		r.state.Store(int32(StateIdle))
		log.Info("claim rejected, job dropped", "error", err.Error())
		return Rejected
	}
	log.Info("track claimed", "leaseTtlSec", claim.LeaseTtlSec, "heartbeatSec", claim.HeartbeatSec)
	return r.work(shutdown, job, claim, log)
}

func (r *Runner) work(shutdown context.Context, job *jobs.Job, claim control.Claim, log *slog.Logger) Outcome {
	r.state.Store(int32(StateConnecting))
	lease := time.Duration(max(claim.LeaseTtlSec, 1)) * time.Second
	beat := time.Duration(max(claim.HeartbeatSec, 1)) * time.Second
	r.leaseTTL.Store(int64(lease))
	r.lastBeat.Store(time.Now().UnixNano())

	jobCtx, off := context.WithCancel(context.Background())
	defer off()
	box := &causeBox{off: off}
	stopOnShutdown := context.AfterFunc(shutdown, func() { box.set(causeSigterm) })
	defer stopOnShutdown()

	src, err := r.d.NewSource(job)
	if err != nil {
		box.set(failed("media_in: " + err.Error()))
		return r.teardown(job, box, nil, nil, nil, log)
	}
	sink, err := r.d.NewSink(job)
	if err != nil {
		box.set(failed("media_out: " + err.Error()))
		return r.teardown(job, box, nil, nil, nil, log)
	}

	inQ := audio.NewFrameQueue(int(r.o.InBuffer / audio.FrameDuration))
	gcfg := r.o.Gemini
	gcfg.Lang = job.Language
	gcfg.Log = log
	mgr := gemini.NewManager(r.d.Gemini, inQ, gcfg)
	var rateWarned atomic.Bool
	mgr.OnAudio = func(pcm []byte, rate int) {
		if rate != audio.OutRate && rateWarned.CompareAndSwap(false, true) {
			log.Warn("unexpected output sample rate, audio will play at the wrong speed", "rate", rate)
		}
		sink.Enqueue(pcm)
	}
	mgr.OnInterrupted = sink.Clear

	sinkCtx, stopSink := context.WithCancel(context.Background())
	g, gctx := errgroup.WithContext(jobCtx)
	g.Go(func() error {
		if err := sink.Run(sinkCtx); err != nil {
			box.set(failed("media_out: " + err.Error()))
		}
		return nil
	})
	g.Go(func() error {
		if err := src.Run(gctx, inQ.Push); err != nil {
			box.set(failed("media_in: " + err.Error()))
		}
		return nil
	})
	g.Go(func() error {
		err := mgr.Run(gctx, func() { r.reportLive(gctx, job, box, log) })
		if gctx.Err() == nil && err != nil {
			box.set(failed("gemini_failed: " + err.Error()))
		}
		return nil
	})
	g.Go(func() error {
		r.heartbeat(gctx, job, beat, lease, mgr, inQ, sink, box, log)
		return nil
	})
	g.Go(func() error {
		t := time.NewTimer(r.o.MaxJob)
		defer t.Stop()
		select {
		case <-gctx.Done():
		case <-t.C:
			box.set(causeMaxLen)
		}
		return nil
	})

	<-jobCtx.Done()
	return r.teardown(job, box, sink, stopSink, g, log)
}

// reportLive tells Hono the stream is open (live means ready).
func (r *Runner) reportLive(ctx context.Context, job *jobs.Job, box *causeBox, log *slog.Logger) {
	r.state.CompareAndSwap(int32(StateConnecting), int32(StateLive))
	err := r.d.Control.Status(ctx, job.TrackId, api.TrackStatusLive, "")
	switch {
	case err == nil:
		log.Info("track live")
	case errors.Is(err, control.ErrEnded):
		box.set(causeEnded)
	case control.IsConflict(err):
		box.set(causeFenced)
	case ctx.Err() == nil:
		// Not fatal: heartbeats keep the lease and carry state "live".
		log.Warn("status live failed", "error", err.Error())
	}
}

func (r *Runner) heartbeat(ctx context.Context, job *jobs.Job, every, lease time.Duration, mgr *gemini.Manager, inQ *audio.FrameQueue, sink media.Sink, box *causeBox, log *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		state := api.WorkerStateConnecting
		switch mgr.State() {
		case gemini.StateLive:
			state = api.WorkerStateLive
			r.state.CompareAndSwap(int32(StateReconnecting), int32(StateLive))
		case gemini.StateReconnecting:
			state = api.WorkerStateReconnecting
			r.state.CompareAndSwap(int32(StateLive), int32(StateReconnecting))
		}
		hctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		ttl, err := r.d.Control.Heartbeat(hctx, job.TrackId, control.Heartbeat{
			State:           state,
			InDroppedFrames: int(inQ.Dropped()),
			OutBufferMs:     int(sink.Buffered() / time.Millisecond),
			Reconnects:      mgr.Reconnects(),
		})
		cancel()
		switch {
		case err == nil:
			r.lastBeat.Store(time.Now().UnixNano())
			if ttl > 0 {
				lease = ttl
				r.leaseTTL.Store(int64(ttl))
			}
		case errors.Is(err, control.ErrEnded):
			log.Info("session ended (heartbeat 409)")
			box.set(causeEnded)
			return
		case control.IsConflict(err):
			log.Warn("fenced: another worker owns the track")
			box.set(causeFenced)
			return
		case ctx.Err() != nil:
			return
		default:
			since := time.Since(time.Unix(0, r.lastBeat.Load()))
			log.Warn("heartbeat failed", "error", err.Error(), "sinceLastOk", since.Round(time.Millisecond).String())
			if since >= lease-r.o.LeaseMargin {
				log.Warn("lease about to expire without a heartbeat, stopping")
				box.set(cause{Fenced, StateFenced, "lease_lost"})
				return
			}
		}
	}
}

// teardown is the only way out of a claimed job.
func (r *Runner) teardown(job *jobs.Job, box *causeBox, sink media.Sink, stopSink context.CancelFunc, g *errgroup.Group, log *slog.Logger) Outcome {
	c := box.get()
	r.state.Store(int32(c.state))
	log = log.With("outcome", string(c.outcome), "reason", c.reason)
	log.Info("stopping job")

	// Input and Gemini stop with the job context (already cancelled). Let the
	// translated audio already queued play out briefly, unless fenced.
	if sink != nil && c.outcome != Fenced {
		deadline := time.Now().Add(r.o.DrainTimeout)
		for sink.Buffered() > 0 && time.Now().Before(deadline) {
			time.Sleep(audio.FrameDuration)
		}
	}
	if stopSink != nil {
		stopSink()
	}
	if g != nil {
		waited := make(chan struct{})
		go func() { g.Wait(); close(waited) }()
		select {
		case <-waited:
		case <-time.After(r.o.WaitTimeout):
			log.Warn("job goroutines did not stop in time")
		}
	}
	if sink != nil {
		if err := sink.Close(); err != nil {
			log.Warn("closing output failed", "error", err.Error())
		}
	}

	// The last word to Hono, on a fresh context: the job context is gone.
	// Fenced or ended by Hono: nothing to say. Any 409 here also means done.
	ctx, cancel := context.WithTimeout(context.Background(), r.o.FinalTimeout)
	defer cancel()
	var err error
	switch {
	case c.outcome == Released:
		err = r.d.Control.Release(ctx, job.TrackId, api.Sigterm)
	case c.outcome == Failed:
		err = r.d.Control.Status(ctx, job.TrackId, api.TrackStatusFailed, truncate(c.reason, 500))
	case c == causeMaxLen:
		err = r.d.Control.Status(ctx, job.TrackId, api.TrackStatusEnded, c.reason)
	}
	if err != nil && !control.IsConflict(err) {
		log.Warn("final call to Hono failed", "error", err.Error())
	}
	r.state.Store(int32(StateDone))
	log.Info("job finished")
	return c.outcome
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
