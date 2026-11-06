// Package gemini is a scripted stand-in for the Gemini Live API. Sessions
// echo: every audio chunk sent comes back as translated audio (1.5× the bytes,
// as 16 kHz in becomes 24 kHz out), and tests can push GoAway, errors and
// interruptions.
package gemini

import (
	"context"
	"errors"
	"sync"
	"time"

	realgemini "github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
)

// ErrClosed is returned by a closed session.
var ErrClosed = errors.New("fake gemini: session closed")

// Connector opens fake sessions.
type Connector struct {
	mu       sync.Mutex
	failNext int
	failErr  error
	sessions []*Session
	handles  []string
	// Echo turns sent audio into translated audio. Default true.
	Echo bool
	// EchoDelay delays each echoed chunk (models latency).
	EchoDelay time.Duration
	// BlockSend makes SendAudio block until the session is closed (write stall).
	BlockSend bool
	// BlockFirst makes only the first n sessions block on send.
	BlockFirst int
	// OnConnect, if set, runs for each new session before it is returned.
	OnConnect func(s *Session)
}

// NewConnector returns an echoing connector.
func NewConnector() *Connector { return &Connector{Echo: true} }

// FailNext makes the next n Connect calls fail with err.
func (c *Connector) FailNext(n int, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failNext, c.failErr = n, err
}

// Connect implements gemini.Connector.
func (c *Connector) Connect(ctx context.Context, lang, handle string) (realgemini.Session, error) {
	c.mu.Lock()
	c.handles = append(c.handles, handle)
	if c.failNext > 0 {
		c.failNext--
		err := c.failErr
		c.mu.Unlock()
		if err == nil {
			err = errors.New("fake gemini: connect failed")
		}
		return nil, err
	}
	block := c.BlockSend || len(c.sessions) < c.BlockFirst
	s := &Session{Lang: lang, Handle: handle, events: make(chan result, 256), done: make(chan struct{}), echo: c.Echo, delay: c.EchoDelay, block: block}
	c.sessions = append(c.sessions, s)
	hook := c.OnConnect
	c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if hook != nil {
		hook(s)
	}
	return s, nil
}

// Sessions returns every session opened so far.
func (c *Connector) Sessions() []*Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*Session(nil), c.sessions...)
}

// Last returns the most recent session, or nil.
func (c *Connector) Last() *Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sessions) == 0 {
		return nil
	}
	return c.sessions[len(c.sessions)-1]
}

// Handles returns the resume handle passed to each Connect call.
func (c *Connector) Handles() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.handles...)
}

type result struct {
	ev  realgemini.Event
	err error
}

// Session is one fake connection.
type Session struct {
	Lang   string
	Handle string

	events chan result
	done   chan struct{}
	once   sync.Once
	echo   bool
	delay  time.Duration
	block  bool

	mu   sync.Mutex
	sent [][]byte
}

// SendAudio implements gemini.Session.
func (s *Session) SendAudio(pcm []byte) error {
	select {
	case <-s.done:
		return ErrClosed
	default:
	}
	if s.block {
		<-s.done
		return ErrClosed
	}
	s.mu.Lock()
	s.sent = append(s.sent, append([]byte(nil), pcm...))
	s.mu.Unlock()
	if s.echo {
		out := make([]byte, len(pcm)*3/2)
		if s.delay > 0 {
			go func() {
				select {
				case <-time.After(s.delay):
					s.Push(realgemini.Event{Audio: out, AudioRate: 24000, AudioMIME: "audio/pcm;rate=24000"})
				case <-s.done:
				}
			}()
		} else {
			s.Push(realgemini.Event{Audio: out, AudioRate: 24000, AudioMIME: "audio/pcm;rate=24000"})
		}
	}
	return nil
}

// Recv implements gemini.Session.
func (s *Session) Recv() (realgemini.Event, error) {
	select {
	case r := <-s.events:
		return r.ev, r.err
	case <-s.done:
		return realgemini.Event{}, ErrClosed
	}
}

// Close implements gemini.Session. It is safe to call more than once.
func (s *Session) Close() error {
	s.once.Do(func() { close(s.done) })
	return nil
}

// Closed reports whether Close was called.
func (s *Session) Closed() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

// Push delivers an event to Recv.
func (s *Session) Push(e realgemini.Event) {
	select {
	case s.events <- result{ev: e}:
	case <-s.done:
	}
}

// Fail makes Recv return err (the server dropped the connection).
func (s *Session) Fail(err error) {
	select {
	case s.events <- result{err: err}:
	case <-s.done:
	}
}

// GoAway announces the connection will close soon.
func (s *Session) GoAway(left time.Duration) { s.Push(realgemini.Event{GoAway: &left}) }

// Resumable offers a new resume handle.
func (s *Session) Resumable(handle string) { s.Push(realgemini.Event{ResumeHandle: handle}) }

// Sent returns the audio chunks sent on this session.
func (s *Session) Sent() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]byte(nil), s.sent...)
}
