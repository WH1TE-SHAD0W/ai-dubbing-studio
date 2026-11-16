package gemini

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
)

// State of the stream, as reported in heartbeats.
type State int32

const (
	StateConnecting State = iota
	StateLive
	StateReconnecting
)

func (s State) String() string {
	switch s {
	case StateLive:
		return "live"
	case StateReconnecting:
		return "reconnecting"
	default:
		return "connecting"
	}
}

// ManagerConfig tunes the stream manager. Zero values get the defaults.
type ManagerConfig struct {
	Lang string
	// Backoff before retry n (the first attempt is immediate). Default 500 ms, 1.5 s, 4 s.
	Backoff []time.Duration
	// MaxRetries is how many failures in a row are tolerated (failed connects
	// and sessions that died before StableAfter). Default 3.
	MaxRetries int
	// StableAfter resets the failure streak once a session lived this long. Default 10 s.
	StableAfter time.Duration
	// WriteStall closes a session whose send has blocked this long. Default 5 s.
	WriteStall time.Duration
	// ChunkBytes is the size of each audio message. Default 100 ms at 16 kHz.
	ChunkBytes int
	// OldSessionGrace keeps reading a replaced session this long. Default 500 ms.
	OldSessionGrace time.Duration
	Log             *slog.Logger
	LogTranscripts  bool
}

func (c *ManagerConfig) defaults() {
	if len(c.Backoff) == 0 {
		c.Backoff = []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond, 4 * time.Second}
	}
	if c.MaxRetries <= 0 {
		c.MaxRetries = 3
	}
	if c.StableAfter <= 0 {
		c.StableAfter = 10 * time.Second
	}
	if c.WriteStall <= 0 {
		c.WriteStall = 5 * time.Second
	}
	if c.ChunkBytes <= 0 {
		c.ChunkBytes = audio.Bytes(audio.InRate, 100*time.Millisecond)
	}
	if c.OldSessionGrace <= 0 {
		c.OldSessionGrace = 500 * time.Millisecond
	}
	if c.Log == nil {
		c.Log = slog.New(slog.DiscardHandler)
	}
}

// Manager keeps one translation stream alive for one language. Input comes
// from a frame queue (20 ms frames); translated audio goes to OnAudio.
type Manager struct {
	cfg  ManagerConfig
	conn Connector
	in   *audio.FrameQueue

	// OnAudio receives translated audio (any session generation: a replaced
	// session's last words still count). OnInterrupted is called when the
	// current session reports an interruption. Both run on the manager loop.
	OnAudio       func(pcm []byte, rate int)
	OnInterrupted func()

	state      atomic.Int32
	reconnects atomic.Int64
	cur        atomic.Pointer[ref]
	// sendStarted is the UnixNano time the current send began, 0 when idle.
	sendStarted atomic.Int64
}

type ref struct {
	s   Session
	gen int64
}

type event struct {
	gen int64
	ev  Event
	err error
}

type replaced struct {
	s        Session
	attempts int
	err      error
}

// NewManager returns a manager reading frames from in.
func NewManager(conn Connector, in *audio.FrameQueue, cfg ManagerConfig) *Manager {
	cfg.defaults()
	m := &Manager{cfg: cfg, conn: conn, in: in, OnAudio: func([]byte, int) {}, OnInterrupted: func() {}}
	m.state.Store(int32(StateConnecting))
	return m
}

// State returns the current stream state.
func (m *Manager) State() State { return State(m.state.Load()) }

// Reconnects returns how many times the stream was replaced.
func (m *Manager) Reconnects() int { return int(m.reconnects.Load()) }

// Run opens the stream, calls onLive once it is open, and keeps it alive
// until ctx ends (returns the cause) or the retries run out (returns an
// error wrapping ErrRetriesExhausted).
func (m *Manager) Run(ctx context.Context, onLive func()) error {
	log := m.cfg.Log.With("lang", m.cfg.Lang)
	first, attempts, err := m.connect(ctx, "", m.cfg.MaxRetries)
	if err != nil {
		return err
	}
	streak := attempts - 1

	// Everything started below stops when Run returns, for any reason.
	done := make(chan struct{})
	events := make(chan event, 64)
	replacedCh := make(chan replaced, 1)
	var wg sync.WaitGroup
	defer wg.Wait()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer close(done)

	var (
		gen         int64
		connectedAt time.Time
		replacing   bool
		handle      string
		olds        []Session
		firstAudio  = true
	)
	setCurrent := func(s Session) {
		gen++
		m.cur.Store(&ref{s: s, gen: gen})
		connectedAt = time.Now()
		m.state.Store(int32(StateLive))
		wg.Add(1)
		go func(s Session, g int64) {
			defer wg.Done()
			for {
				e, err := s.Recv()
				select {
				case events <- event{gen: g, ev: e, err: err}:
				case <-done:
					return
				}
				if err != nil {
					return
				}
			}
		}(s, gen)
	}
	closeAll := func() {
		if r := m.cur.Swap(nil); r != nil {
			r.s.Close()
		}
		for _, s := range olds {
			s.Close()
		}
	}
	defer closeAll()

	startReplace := func(reason string, initialDelay time.Duration) {
		replacing = true
		budget := m.cfg.MaxRetries - streak
		h := handle
		log.Info("gemini: replacing stream", "reason", reason, "resume", h != "", "budget", budget)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if budget <= 0 {
				replacedCh <- replaced{err: fmt.Errorf("%w: too many failures in a row", ErrRetriesExhausted)}
				return
			}
			if initialDelay > 0 {
				select {
				case <-runCtx.Done():
					replacedCh <- replaced{err: context.Cause(runCtx)}
					return
				case <-time.After(initialDelay):
				}
			}
			s, n, err := m.connect(runCtx, h, budget)
			if err == nil && runCtx.Err() != nil {
				s.Close()
				err = context.Cause(runCtx)
			}
			replacedCh <- replaced{s: s, attempts: n, err: err}
		}()
	}

	setCurrent(first)
	log.Info("gemini: stream open", "attempts", attempts)
	onLive()

	wg.Add(2)
	go func() { defer wg.Done(); m.send(runCtx) }()
	go func() { defer wg.Done(); m.watchdog(runCtx, log) }()

	for {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)

		case r := <-replacedCh:
			replacing = false
			if r.err != nil {
				return r.err
			}
			streak += r.attempts - 1
			if old := m.cur.Load(); old != nil {
				olds = append(olds, old.s)
				oldS := old.s
				time.AfterFunc(m.cfg.OldSessionGrace, func() { oldS.Close() })
			}
			setCurrent(r.s)
			m.reconnects.Add(1)
			log.Info("gemini: stream replaced", "generation", gen)

		case e := <-events:
			cur := m.cur.Load()
			isCurrent := cur != nil && e.gen == cur.gen
			if e.err != nil {
				if !isCurrent {
					continue // a session we closed, or one already replaced
				}
				lived := time.Since(connectedAt)
				if lived < m.cfg.StableAfter {
					streak++
				} else {
					streak = 0
				}
				log.Warn("gemini: stream closed", "error", e.err.Error(), "lived", lived.Round(time.Millisecond).String(), "streak", streak)
				m.cur.Store(nil)
				cur.s.Close()
				m.state.Store(int32(StateReconnecting))
				if !replacing {
					var delay time.Duration
					if streak > 0 {
						delay = m.cfg.Backoff[min(streak-1, len(m.cfg.Backoff)-1)]
					}
					startReplace("error", delay)
				}
				continue
			}
			ev := e.ev
			if len(ev.Audio) > 0 {
				if firstAudio {
					firstAudio = false
					log.Info("gemini: first translated audio", "bytes", len(ev.Audio), "mime", ev.AudioMIME)
				}
				rate := ev.AudioRate
				if rate == 0 {
					rate = audio.OutRate
				}
				m.OnAudio(ev.Audio, rate)
			}
			m.logTranscript(log, "source", ev.Input)
			m.logTranscript(log, "target", ev.Output)
			if !isCurrent {
				continue
			}
			if ev.ResumeHandle != "" {
				handle = ev.ResumeHandle
			}
			if ev.Interrupted {
				log.Info("gemini: interrupted, dropping queued audio")
				m.OnInterrupted()
			}
			if ev.GoAway != nil && !replacing {
				log.Info("gemini: goAway", "timeLeft", ev.GoAway.String())
				startReplace("goaway", 0)
			}
		}
	}
}

// connect tries up to budget times. After a failed attempt with a resume
// handle, the next attempts start a fresh session (the handle may be stale).
func (m *Manager) connect(ctx context.Context, handle string, budget int) (Session, int, error) {
	var last error
	for i := 0; i < budget; i++ {
		if i > 0 {
			wait := m.cfg.Backoff[min(i-1, len(m.cfg.Backoff)-1)]
			select {
			case <-ctx.Done():
				return nil, i, context.Cause(ctx)
			case <-time.After(wait):
			}
		}
		s, err := m.conn.Connect(ctx, m.cfg.Lang, handle)
		if err == nil {
			return s, i + 1, nil
		}
		if ctx.Err() != nil {
			return nil, i + 1, context.Cause(ctx)
		}
		last = err
		m.cfg.Log.Warn("gemini: connect failed", "lang", m.cfg.Lang, "attempt", i+1, "resume", handle != "", "error", err.Error())
		handle = ""
	}
	return nil, budget, fmt.Errorf("%w: %w", ErrRetriesExhausted, last)
}

// send moves audio from the frame queue to the current session in chunks.
// While there is no session it stops popping, so the queue keeps only the
// freshest audio (drop-oldest) for the next session.
func (m *Manager) send(ctx context.Context) {
	chunker := audio.NewChunker(m.cfg.ChunkBytes)
	for {
		for m.cur.Load() == nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(audio.FrameDuration):
			}
		}
		f, err := m.in.Pop(ctx)
		if err != nil {
			return
		}
		for _, c := range chunker.Push(f) {
			r := m.cur.Load()
			if r == nil {
				continue
			}
			m.sendStarted.Store(time.Now().UnixNano())
			err := r.s.SendAudio(c)
			m.sendStarted.Store(0)
			if err != nil && !errors.Is(err, context.Canceled) {
				// The reader sees the closed connection and triggers the reconnect.
				continue
			}
		}
	}
}

// watchdog closes the current session when a send has been stuck for
// WriteStall: nothing sets a write deadline on the SDK's socket.
func (m *Manager) watchdog(ctx context.Context, log *slog.Logger) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		started := m.sendStarted.Load()
		if started == 0 || time.Since(time.Unix(0, started)) < m.cfg.WriteStall {
			continue
		}
		if r := m.cur.Load(); r != nil {
			log.Warn("gemini: send stalled, closing the stream", "stalled", time.Since(time.Unix(0, started)).Round(time.Millisecond).String())
			r.s.Close()
			m.sendStarted.Store(0)
		}
	}
}

func (m *Manager) logTranscript(log *slog.Logger, kind string, t *Transcript) {
	if t == nil || !log.Enabled(context.Background(), slog.LevelDebug) {
		return
	}
	attrs := []any{"kind", kind, "chars", len(t.Text), "finished", t.Finished, "languageCode", t.LanguageCode}
	if m.cfg.LogTranscripts {
		attrs = append(attrs, "text", t.Text)
	}
	log.Debug("gemini: transcript", attrs...)
}
