package runner_test

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control/api"
	fakecontrol "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/control"
	fakegemini "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/gemini"
	fakemedia "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/fakes/media"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/jobs"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/runner"
)

type acker struct {
	mu  sync.Mutex
	ids []string
}

func (a *acker) Ack(_ context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ids = append(a.ids, id)
	return nil
}

func (a *acker) acked() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.ids...)
}

type env struct {
	store  *fakecontrol.Store
	gem    *fakegemini.Connector
	src    *fakemedia.Source
	sink   *fakemedia.Sink
	acks   *acker
	r      *runner.Runner
	job    *jobs.Job
	srcErr error
}

func newEnv(opts runner.Options) *env {
	e := &env{
		store: fakecontrol.NewStore("t"),
		gem:   fakegemini.NewConnector(),
		src:   &fakemedia.Source{},
		sink:  &fakemedia.Sink{},
		acks:  &acker{},
		job: &jobs.Job{ID: "1-0", TranslationJob: api.TranslationJob{
			V: api.N1, JobId: "j1", SessionId: "s1", TrackId: "t1", Language: "sk",
		}},
	}
	e.store.AddTrack("t1", "s1", "sk")
	e.r = runner.New(runner.Deps{
		Control: e.store.Direct("w1"),
		Queue:   e.acks,
		Gemini:  e.gem,
		NewSource: func(*jobs.Job) (media.Source, error) {
			if e.srcErr != nil {
				return nil, e.srcErr
			}
			return e.src, nil
		},
		NewSink: func(*jobs.Job) (media.Sink, error) { return e.sink, nil },
	}, opts)
	return e
}

// run starts the job in the background and returns its outcome channel.
func (e *env) run(ctx context.Context) <-chan runner.Outcome {
	out := make(chan runner.Outcome, 1)
	go func() { out <- e.r.Run(ctx, e.job) }()
	return out
}

func TestSessionEndStopsTheJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		out := e.run(context.Background())
		time.Sleep(12 * time.Second)
		synctest.Wait()
		if e.r.State() != runner.StateLive || e.store.Get("t1").Status != "live" {
			t.Fatalf("state %v, track %+v", e.r.State(), e.store.Get("t1"))
		}
		if !e.r.Healthy() || e.sink.Bytes() == 0 {
			t.Fatalf("healthy %v, translated %d bytes", e.r.Healthy(), e.sink.Bytes())
		}
		if got := e.acks.acked(); !slices.Equal(got, []string{"1-0"}) {
			t.Fatalf("acked %v", got)
		}

		e.store.End("t1") // host ended the session
		if got := <-out; got != runner.Ended {
			t.Fatalf("outcome %v", got)
		}
		ops := e.store.Ops()
		if ops[0] != "claim" || ops[1] != "status" || ops[len(ops)-1] != "heartbeat" {
			t.Fatalf("calls %v: nothing may follow the heartbeat that said ended", ops)
		}
		if !e.sink.Closed() || !e.gem.Last().Closed() {
			t.Fatal("output or Gemini left open")
		}
	})
}

func TestReplacedWorkerStopsWithoutCallingHono(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		out := e.run(context.Background())
		time.Sleep(time.Second)
		e.store.Steal("t1", "w2")
		if got := <-out; got != runner.Fenced {
			t.Fatalf("outcome %v", got)
		}
		calls := e.store.Calls()
		if last := calls[len(calls)-1]; last.Op != "heartbeat" {
			t.Fatalf("a fenced worker called %s after the 409", last.Op)
		}
		if e.store.Get("t1").Owner != "w2" {
			t.Fatal("the new owner lost the track")
		}
	})
}

func TestSigtermReleasesTheTrack(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		ctx, sigterm := context.WithCancel(context.Background())
		var released []string
		e.store.OnRelease = func(id string) { released = append(released, id) }
		out := e.run(ctx)
		time.Sleep(2 * time.Second)
		sigterm()
		if got := <-out; got != runner.Released {
			t.Fatalf("outcome %v", got)
		}
		if tr := e.store.Get("t1"); tr.Status != "pending" || tr.Owner != "" || tr.Reason != "sigterm" {
			t.Fatalf("track after release %+v", tr)
		}
		if !slices.Equal(released, []string{"t1"}) {
			t.Fatalf("re-enqueued %v", released)
		}
	})
}

func TestSigtermWhileClaimingStillReleases(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		ctx, sigterm := context.WithCancel(context.Background())
		sigterm() // already shutting down when the job arrives
		if got := e.r.Run(ctx, e.job); got != runner.Released {
			t.Fatalf("outcome %v", got)
		}
		if ops := e.store.Ops(); !slices.Equal(ops, []string{"claim", "release"}) {
			t.Fatalf("calls %v", ops)
		}
	})
}

func TestGeminiFailureReportsFailed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		e.gem.FailNext(10, errors.New("model unavailable"))
		if got := <-e.run(context.Background()); got != runner.Failed {
			t.Fatalf("outcome %v", got)
		}
		calls := e.store.Calls()
		last := calls[len(calls)-1]
		if last.Op != "status" || last.Body["status"] != "failed" {
			t.Fatalf("last call %+v", last)
		}
		// Hono puts a failed track back in the queue (until its retry limit).
		if tr := e.store.Get("t1"); tr.Status != "pending" {
			t.Fatalf("track %+v", tr)
		}
	})
}

func TestMediaFailureReportsFailed(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		e.srcErr = errors.New("no input WAV")
		if got := e.r.Run(context.Background(), e.job); got != runner.Failed {
			t.Fatalf("outcome %v", got)
		}
		calls := e.store.Calls()
		if last := calls[len(calls)-1]; last.Body["status"] != "failed" || last.Body["reason"] == "" {
			t.Fatalf("last call %+v", last)
		}
	})
}

func TestClaimConflictIsRejectedAndAcked(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		e.store.Steal("t1", "w2")
		if got := e.r.Run(context.Background(), e.job); got != runner.Rejected {
			t.Fatalf("outcome %v", got)
		}
		if e.r.State() != runner.StateIdle {
			t.Fatalf("state %v, want idle", e.r.State())
		}
		if got := e.acks.acked(); !slices.Equal(got, []string{"1-0"}) {
			t.Fatalf("acked %v: a rejected job must still leave the stream", got)
		}
	})
}

func TestMaxJobLengthEndsTheTrack(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{MaxJob: time.Minute})
		if got := <-e.run(context.Background()); got != runner.Ended {
			t.Fatalf("outcome %v", got)
		}
		calls := e.store.Calls()
		last := calls[len(calls)-1]
		if last.Body["status"] != "ended" || last.Body["reason"] != "max_duration" {
			t.Fatalf("last call %+v", last)
		}
	})
}

func TestLostLeaseStopsTheJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		e := newEnv(runner.Options{})
		time.AfterFunc(time.Second, func() { e.store.FailNext("heartbeat", 100) })
		out := e.run(context.Background())
		time.Sleep(11 * time.Second)
		synctest.Wait()
		if e.r.Healthy() != true {
			t.Fatal("unhealthy before the lease ran out")
		}
		if got := <-out; got != runner.Fenced {
			t.Fatalf("outcome %v", got)
		}
	})
}
