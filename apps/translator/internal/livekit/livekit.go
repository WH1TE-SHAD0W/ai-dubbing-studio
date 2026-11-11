// Package livekit is the LiveKit media adapter (ADR-0020). Source joins the
// session's source room hidden and listen-only and delivers the host's mic;
// Sink joins the track's output room publish-only and plays the translation
// into one audio track. The tokens come from Hono's claim response, so the
// worker never holds the LiveKit API secret.
//
// Opus encoding and resampling need cgo (libopus, libsoxr). They live behind
// the livekit build tag (pcm_livekit.go); without it NewSource and NewSink
// return ErrUnavailable, so the rest of the worker builds and tests anywhere.
package livekit

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	msdk "github.com/livekit/media-sdk"
	lkproto "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
)

// ErrUnavailable: the binary was built without the livekit tag.
var ErrUnavailable = errors.New("livekit: this build has no LiveKit media support (build with -tags livekit)")

// hostSilence: with no host audio for this long, Source sends silence, so
// Gemini gets a steady stream while the host is muted or reconnecting (the
// WAV source does the same after its file ends).
const hostSilence = 100 * time.Millisecond

// remoteTrack decodes a subscribed track to PCM (pcm_livekit.go).
type remoteTrack interface{ Close() }

// localTrack encodes PCM into a published Opus track and paces it itself,
// one 20 ms frame per tick, with silence when its queue is empty.
type localTrack interface {
	webrtc.TrackLocal
	WriteSample(msdk.PCM16Sample) error
	ClearQueue()
	Close() error
}

// pcmWriter receives decoded PCM from a remote track.
type pcmWriter struct{ write func(msdk.PCM16Sample) }

func (w pcmWriter) WriteSample(s msdk.PCM16Sample) error { w.write(s); return nil }
func (w pcmWriter) Close() error                         { return nil }

// leftErr maps why LiveKit disconnected us to the media errors the runner
// understands. Leaving ourselves returns nil.
func leftErr(reason lkproto.DisconnectReason) error {
	switch reason {
	case lkproto.DisconnectReason_CLIENT_INITIATED:
		return nil
	case lkproto.DisconnectReason_ROOM_DELETED, lkproto.DisconnectReason_ROOM_CLOSED, lkproto.DisconnectReason_PARTICIPANT_REMOVED:
		return media.ErrRoomClosed
	case lkproto.DisconnectReason_DUPLICATE_IDENTITY:
		return media.ErrReplaced
	default:
		return fmt.Errorf("livekit: disconnected (%s)", reason)
	}
}

// room is what Source and Sink share: the connection and its end.
type room struct {
	r        atomic.Pointer[lksdk.Room]
	gone     chan struct{}
	goneOnce sync.Once
	leave    sync.Once
}

func newRoom() *room { return &room{gone: make(chan struct{})} }

func (r *room) onDisconnected() { r.goneOnce.Do(func() { close(r.gone) }) }

// err is why the room ended (call after gone is closed).
func (r *room) err() error {
	lr := r.r.Load()
	if lr == nil {
		return errors.New("livekit: disconnected")
	}
	return leftErr(lr.DisconnectReason())
}

func (r *room) disconnect() {
	r.leave.Do(func() {
		if lr := r.r.Load(); lr != nil {
			lr.Disconnect()
		}
	})
}

// Source is the host's mic from the session's source room.
type Source struct {
	room   *room
	log    *slog.Logger
	frames chunker

	mu      sync.Mutex
	onFrame func([]byte)
	remote  remoteTrack
	// remoteSID is the publication the decoder belongs to.
	remoteSID string

	lastHost atomic.Int64 // UnixNano of the last host frame
}

// NewSource joins the source room with token (hidden and listen-only, as
// Hono signs it) and subscribes to the host's audio as it appears.
func NewSource(url, token string, log *slog.Logger) (*Source, error) {
	if !supported {
		return nil, ErrUnavailable
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	s := &Source{room: newRoom(), log: log, frames: chunker{size: audio.Bytes(audio.InRate, audio.FrameDuration)}}
	cb := lksdk.NewRoomCallback()
	cb.ParticipantCallback.OnTrackPublished = s.subscribe
	cb.ParticipantCallback.OnTrackSubscribed = s.subscribed
	cb.ParticipantCallback.OnTrackUnsubscribed = s.unsubscribed
	cb.OnDisconnected = s.room.onDisconnected
	lr, err := lksdk.ConnectToRoomWithToken(url, token, cb, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return nil, fmt.Errorf("livekit: join the source room: %w", err)
	}
	s.room.r.Store(lr)
	// A host who published before we joined raises no OnTrackPublished.
	for _, rp := range lr.GetRemoteParticipants() {
		for _, tp := range rp.TrackPublications() {
			if pub, ok := tp.(*lksdk.RemoteTrackPublication); ok {
				s.subscribe(pub, rp)
			}
		}
	}
	log.Info("joined the source room")
	return s, nil
}

// subscribe takes any audio track: only the host can publish in the source
// room (workers are hidden and listen-only).
func (s *Source) subscribe(pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
	if pub.Kind() != lksdk.TrackKindAudio {
		return
	}
	if err := pub.SetSubscribed(true); err != nil {
		s.log.Warn("subscribing to the host failed", "identity", rp.Identity(), "error", err.Error())
	}
}

func (s *Source) subscribed(t *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
	if t.Kind() != webrtc.RTPCodecTypeAudio {
		return
	}
	rt, err := newRemoteTrack(t, pcmWriter{write: s.write})
	if err != nil {
		s.log.Error("decoding the host's audio failed", "identity", rp.Identity(), "error", err.Error())
		return
	}
	s.mu.Lock()
	old := s.remote
	s.remote, s.remoteSID = rt, pub.SID()
	s.mu.Unlock()
	// One mic: a newer track (the host's second device) replaces the old one.
	if old != nil {
		old.Close()
	}
	s.log.Info("receiving the host's audio", "identity", rp.Identity())
}

func (s *Source) unsubscribed(_ *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
	s.mu.Lock()
	var old remoteTrack
	if pub.SID() == s.remoteSID {
		old, s.remote, s.remoteSID = s.remote, nil, ""
	}
	s.mu.Unlock()
	if old != nil {
		old.Close()
		s.log.Info("the host's audio stopped")
	}
}

// write turns decoded host audio into 20 ms frames.
func (s *Source) write(sample msdk.PCM16Sample) {
	s.frames.write(pcmBytes(sample), func(f []byte) {
		s.lastHost.Store(time.Now().UnixNano())
		s.mu.Lock()
		on := s.onFrame
		s.mu.Unlock()
		if on != nil {
			on(f)
		}
	})
}

// Run implements media.Source. It returns media.ErrRoomClosed when Hono
// deletes the source room (the session is ending).
func (s *Source) Run(ctx context.Context, onFrame func([]byte)) error {
	s.mu.Lock()
	s.onFrame = onFrame
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.onFrame = nil
		s.mu.Unlock()
	}()
	silence := make([]byte, s.frames.size)
	t := time.NewTicker(audio.FrameDuration)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.room.gone:
			if err := s.room.err(); err != nil {
				return err
			}
			return errors.New("livekit: left the source room")
		case <-t.C:
			if time.Since(time.Unix(0, s.lastHost.Load())) > hostSilence {
				onFrame(silence)
			}
		}
	}
}

// Close implements media.Source: it leaves the source room.
func (s *Source) Close() error {
	s.mu.Lock()
	old := s.remote
	s.remote, s.remoteSID = nil, ""
	s.mu.Unlock()
	if old != nil {
		old.Close()
	}
	s.room.disconnect()
	return nil
}

// Sink is the translation, published as one audio track in the output room.
type Sink struct {
	room  *room
	track localTrack
	buf   *audio.ByteBuffer
	frame int
	close sync.Once
}

// NewSink joins the output room with token (publish-only, as Hono signs it)
// and publishes one mono track called name (the language code).
func NewSink(url, token, name string, maxBuffer time.Duration, log *slog.Logger) (*Sink, error) {
	if !supported {
		return nil, ErrUnavailable
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	track, err := newLocalTrack(audio.OutRate)
	if err != nil {
		return nil, fmt.Errorf("livekit: output track: %w", err)
	}
	s := newSink(track, maxBuffer)
	cb := lksdk.NewRoomCallback()
	cb.OnDisconnected = s.room.onDisconnected
	lr, err := lksdk.ConnectToRoomWithToken(url, token, cb, lksdk.WithAutoSubscribe(false))
	if err != nil {
		_ = track.Close()
		return nil, fmt.Errorf("livekit: join the output room: %w", err)
	}
	s.room.r.Store(lr)
	if _, err := lr.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: name}); err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("livekit: publish the %s track: %w", name, err)
	}
	log.Info("joined the output room", "track", name)
	return s, nil
}

func newSink(track localTrack, maxBuffer time.Duration) *Sink {
	return &Sink{
		room:  newRoom(),
		track: track,
		buf:   audio.NewByteBuffer(audio.Bytes(audio.OutRate, maxBuffer)),
		frame: audio.Bytes(audio.OutRate, audio.FrameDuration),
	}
}

// Enqueue implements media.Sink.
func (s *Sink) Enqueue(pcm []byte) { s.buf.Write(pcm) }

// Clear implements media.Sink: it drops our queue and the track's.
func (s *Sink) Clear() {
	s.buf.Reset()
	s.track.ClearQueue()
}

// Buffered implements media.Sink. It leaves out the track's own lead of up to
// two frames.
func (s *Sink) Buffered() time.Duration { return audio.Duration(audio.OutRate, s.buf.Len()) }

// Dropped returns how many bytes were dropped because the buffer was full.
func (s *Sink) Dropped() uint64 { return s.buf.Dropped() }

// Run implements media.Sink. The track sends one frame per 20 ms tick, so Run
// hands it one per tick too, with a lead of one extra frame whenever audio
// starts again, so the two tickers never leave a gap. It returns
// media.ErrRoomClosed when the output room is deleted, and media.ErrReplaced
// when another participant joins with our identity.
func (s *Sink) Run(ctx context.Context) error {
	t := time.NewTicker(audio.FrameDuration)
	defer t.Stop()
	primed := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.room.gone:
			if err := s.room.err(); err != nil {
				return err
			}
			return errors.New("livekit: left the output room")
		case <-t.C:
		}
		if s.buf.Len() == 0 {
			primed = false
			continue
		}
		n := 1
		if !primed {
			n, primed = 2, true
		}
		for range n {
			out := s.buf.Read(s.frame)
			if len(out) == 0 {
				break
			}
			if err := s.track.WriteSample(pcmSamples(out)); err != nil {
				return fmt.Errorf("livekit: write the output track: %w", err)
			}
		}
	}
}

// Close implements media.Sink: it stops the track and leaves the output room.
func (s *Sink) Close() error {
	s.close.Do(func() {
		_ = s.track.Close()
		s.room.disconnect()
	})
	return nil
}

// chunker cuts a byte stream into frames of size bytes.
type chunker struct {
	size int
	mu   sync.Mutex
	buf  []byte
}

func (c *chunker) write(p []byte, emit func([]byte)) {
	c.mu.Lock()
	c.buf = append(c.buf, p...)
	var out [][]byte
	for len(c.buf) >= c.size {
		f := make([]byte, c.size)
		copy(f, c.buf)
		out = append(out, f)
		c.buf = c.buf[c.size:]
	}
	if len(c.buf) == 0 {
		c.buf = nil // let the backing array go
	}
	c.mu.Unlock()
	for _, f := range out {
		emit(f)
	}
}

func pcmBytes(s msdk.PCM16Sample) []byte {
	out := make([]byte, 0, len(s)*audio.BytesPerSample)
	for _, v := range s {
		out = binary.LittleEndian.AppendUint16(out, uint16(v))
	}
	return out
}

func pcmSamples(b []byte) msdk.PCM16Sample {
	out := make(msdk.PCM16Sample, len(b)/audio.BytesPerSample)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return out
}

var (
	_ media.Source = (*Source)(nil)
	_ media.Sink   = (*Sink)(nil)
)
