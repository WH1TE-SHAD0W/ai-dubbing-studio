// Command translator is the translation worker (ADR-0018/0019/0020): it
// waits on the Redis Stream for one job, claims it through Hono, runs one
// Gemini Live Translate stream for it, and exits.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/config"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/control"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/httpserver"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/jobs"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/lifecycle"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/livekit"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/runner"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check the local /health endpoint and exit (for container healthchecks)")
	flag.Parse()
	if *healthcheck {
		addr := os.Getenv("HTTP_ADDR")
		if addr == "" {
			addr = ":8080"
		}
		if err := httpserver.Check(addr); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel})).With("workerId", cfg.WorkerID)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	code := run(ctx, cfg, log, nil)
	lifecycle.OSExit{}.Exit(code)
}

// worker holds what the probes need to read.
type worker struct {
	r *runner.Runner
	// lastRedisOK is the UnixNano time of the last successful Redis call.
	lastRedisOK atomic.Int64
	// reading is true while blocked in XREADGROUP.
	reading atomic.Bool
}

const redisFresh = 10 * time.Second

func (w *worker) redisOK() bool {
	return time.Since(time.Unix(0, w.lastRedisOK.Load())) < redisFresh
}

// Health implements httpserver.Probe.
func (w *worker) Health() (bool, string) {
	s := w.r.State()
	switch {
	case s.Busy():
		if w.r.Healthy() {
			return true, s.String()
		}
		return false, s.String() + ": lease not renewed"
	case s == runner.StateIdle || s == runner.StateClaiming:
		if w.redisOK() {
			return true, s.String()
		}
		return false, "redis unavailable"
	default:
		return true, s.String() // stopping
	}
}

// Ready implements httpserver.Probe.
func (w *worker) Ready() (bool, string) {
	s := w.r.State()
	switch {
	case s != runner.StateIdle:
		return false, s.String()
	case !w.redisOK():
		return false, "redis unavailable"
	case !w.reading.Load():
		return false, "starting"
	default:
		return true, "idle"
	}
}

// run is the whole worker. conn is nil outside tests (the real Gemini API).
func run(shutdown context.Context, cfg config.Config, log *slog.Logger, conn gemini.Connector) int {
	q, err := jobs.New(cfg.RedisURL, cfg.JobStream, cfg.JobGroup, cfg.WorkerID)
	if err != nil {
		log.Error("redis config", "error", err.Error())
		return 1
	}
	defer q.Close()

	if conn == nil {
		live, err := gemini.NewLive(shutdown, gemini.LiveConfig{
			APIKey:     cfg.GeminiAPIKey,
			Model:      cfg.GeminiModel,
			APIVersion: cfg.GeminiAPIVersion,
		})
		if err != nil {
			log.Error("gemini config", "error", err.Error())
			return 1
		}
		conn = live
	}
	ctl, err := control.New(cfg.ControlURL, cfg.InternalAPIToken, cfg.WorkerID)
	if err != nil {
		log.Error("control config", "error", err.Error())
		return 1
	}

	r := runner.New(runner.Deps{
		Control: ctl,
		Queue:   q,
		Gemini:  conn,
		// LiveKit when the claim carries access to it (ADR-0020), else WAV
		// files, so the job path runs locally without LiveKit.
		NewSource: func(j *jobs.Job, c control.Claim) (media.Source, error) {
			if lk := c.Livekit; lk != nil {
				return livekit.NewSource(lk.Url, lk.SourceToken, log.With("room", "source"))
			}
			p, err := media.InputPath(cfg.MediaDir, j.Language)
			if err != nil {
				return nil, err
			}
			return media.NewWAVSource(p)
		},
		NewSink: func(j *jobs.Job, c control.Claim) (media.Sink, error) {
			if lk := c.Livekit; lk != nil {
				return livekit.NewSink(lk.Url, lk.OutputToken, string(j.Language), cfg.OutBufferMax, log.With("room", "output"))
			}
			return media.NewWAVSink(media.OutputPath(cfg.MediaDir, j.SessionId, j.Language, cfg.WorkerID), cfg.OutBufferMax)
		},
		Log: log,
	}, runner.Options{
		MaxJob:   cfg.MaxJob,
		InBuffer: cfg.InBuffer,
		Gemini: gemini.ManagerConfig{
			MaxRetries:     cfg.GeminiMaxRetries,
			ChunkBytes:     audio.Bytes(audio.InRate, cfg.SendChunk),
			LogTranscripts: cfg.LogTranscripts,
		},
	})
	w := &worker{r: r}

	srv := httpserver.New(cfg.HTTPAddr, w)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("probe server", "error", err.Error())
		}
	}()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	log.Info("worker starting", "model", cfg.GeminiModel, "stream", cfg.JobStream, "group", cfg.JobGroup)
	code := loop(shutdown, cfg, q, w, log)

	// Single-use: leave the group so no stale consumer stays behind.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := q.DeleteConsumer(ctx); err != nil {
		log.Warn("could not remove the consumer", "error", err.Error())
	}
	log.Info("worker exiting", "code", code)
	return code
}

// loop waits for jobs until one is processed, then returns. A rejected claim
// leaves the worker idle, so it keeps waiting. Returns the exit code.
func loop(shutdown context.Context, cfg config.Config, q *jobs.Queue, w *worker, log *slog.Logger) int {
	// Exit by ourselves when Redis stays unreachable: Compose doesn't restart
	// unhealthy containers, but it restarts exited ones.
	loopCtx, cancel := context.WithCancelCause(shutdown)
	defer cancel(nil)
	errUnhealthy := errors.New("unhealthy for too long")
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var since time.Time
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-t.C:
			}
			if ok, _ := w.Health(); ok || w.r.State() != runner.StateIdle {
				since = time.Time{}
				continue
			}
			if since.IsZero() {
				since = time.Now()
			}
			if time.Since(since) >= cfg.UnhealthyExit {
				log.Error("unhealthy for too long, exiting", "for", cfg.UnhealthyExit.String())
				cancel(errUnhealthy)
				return
			}
		}
	}()

	for loopCtx.Err() == nil {
		if err := q.EnsureGroup(loopCtx); err != nil {
			log.Warn("redis not ready", "error", err.Error())
			sleep(loopCtx, time.Second)
			continue
		}
		w.lastRedisOK.Store(time.Now().UnixNano())
		break
	}

	for loopCtx.Err() == nil {
		w.reading.Store(true)
		job, err := q.Read(loopCtx)
		w.reading.Store(false)
		if loopCtx.Err() != nil {
			break
		}
		if err != nil {
			if errors.Is(err, jobs.ErrMalformed) {
				w.lastRedisOK.Store(time.Now().UnixNano())
				log.Warn("dropping a malformed job", "error", err.Error())
				_ = q.Ack(loopCtx, job.ID)
				continue
			}
			log.Warn("reading the stream failed", "error", err.Error())
			if errors.Is(err, context.Canceled) {
				break
			}
			// The group may be gone (Redis restarted without its data).
			_ = q.EnsureGroup(loopCtx)
			sleep(loopCtx, time.Second)
			continue
		}
		w.lastRedisOK.Store(time.Now().UnixNano())
		if job == nil {
			continue
		}
		if out := w.r.Run(shutdown, job); out == runner.Rejected {
			continue
		}
		return 0
	}
	if errors.Is(context.Cause(loopCtx), errUnhealthy) {
		return 1
	}
	return 0
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
