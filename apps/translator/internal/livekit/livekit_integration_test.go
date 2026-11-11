//go:build livekit && integration

// Integration test: Source and Sink against a real LiveKit server. Needs
// cgo with libopus and libsoxr, and a server started with --dev:
//
//	LIVEKIT_URL=ws://localhost:7880 go test -tags livekit,nolibopusfile,integration ./internal/livekit/
//
// LIVEKIT_API_KEY and LIVEKIT_API_SECRET default to the --dev keys.
package livekit

import (
	"context"
	"errors"
	"math"
	"os"
	"sync/atomic"
	"testing"
	"time"

	msdk "github.com/livekit/media-sdk"
	"github.com/livekit/protocol/auth"
	lkproto "github.com/livekit/protocol/livekit"
	protoLogger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
	"github.com/pion/webrtc/v4"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/media"
)

type server struct{ url, key, secret string }

func liveKit(t *testing.T) server {
	t.Helper()
	s := server{os.Getenv("LIVEKIT_URL"), os.Getenv("LIVEKIT_API_KEY"), os.Getenv("LIVEKIT_API_SECRET")}
	if s.url == "" {
		t.Skip("LIVEKIT_URL not set")
	}
	if s.key == "" {
		s.key, s.secret = "devkey", "secret"
	}
	return s
}

// token signs grants the way Hono does (apps/api/src/livekit/tokens.ts).
func (s server) token(t *testing.T, identity string, g *auth.VideoGrant) string {
	t.Helper()
	g.RoomJoin = true
	jwt, err := auth.NewAccessToken(s.key, s.secret).SetIdentity(identity).SetVideoGrant(g).SetValidFor(time.Hour).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	return jwt
}

func yes() *bool { v := true; return &v }
func no() *bool  { v := false; return &v }

// tone is 20 ms of a 440 Hz sine at rate.
func tone(rate int, phase *float64) msdk.PCM16Sample {
	n := rate / 50
	out := make(msdk.PCM16Sample, n)
	for i := range out {
		out[i] = int16(8000 * math.Sin(*phase))
		*phase += 2 * math.Pi * 440 / float64(rate)
	}
	return out
}

func loud(f []byte) bool {
	for i := 0; i+1 < len(f); i += 2 {
		v := int16(uint16(f[i]) | uint16(f[i+1])<<8)
		if v > 1000 || v < -1000 {
			return true
		}
	}
	return false
}

// host publishes a tone into the source room, like the Studio's mic.
func host(t *testing.T, s server, room string) {
	t.Helper()
	r, err := lksdk.ConnectToRoomWithToken(s.url, s.token(t, "host-1", &auth.VideoGrant{Room: room, CanPublish: yes(), CanSubscribe: no()}), lksdk.NewRoomCallback())
	if err != nil {
		t.Fatal(err)
	}
	tr, err := lkmedia.NewPCMLocalTrack(48000, 1, protoLogger.GetLogger())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.LocalParticipant.PublishTrack(tr, &lksdk.TrackPublicationOptions{Name: "mic", Source: lkproto.TrackSource_MICROPHONE}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		phase := 0.0
		tk := time.NewTicker(20 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				_ = tr.WriteSample(tone(48000, &phase))
			}
		}
	}()
	t.Cleanup(func() { cancel(); _ = tr.Close(); r.Disconnect() })
}

func TestSourceReceivesTheHostAndEndsWithTheRoom(t *testing.T) {
	s := liveKit(t)
	room := "it-src-" + time.Now().Format("150405.000")
	host(t, s, room)

	src, err := NewSource(s.url, s.token(t, "worker-w1", &auth.VideoGrant{Room: room, CanSubscribe: yes(), CanPublish: no(), CanPublishData: no(), Hidden: true}), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	var frames, loudFrames atomic.Int64
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- src.Run(ctx, func(f []byte) {
			if len(f) != audio.Bytes(audio.InRate, audio.FrameDuration) {
				t.Errorf("frame of %d bytes", len(f))
			}
			frames.Add(1)
			if loud(f) {
				loudFrames.Add(1)
			}
		})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for loudFrames.Load() < 50 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if loudFrames.Load() < 50 {
		t.Fatalf("host audio: %d loud of %d frames in 10 s", loudFrames.Load(), frames.Load())
	}

	// Hono ends the session by deleting the source room.
	rs := lksdk.NewRoomServiceClient(httpURL(s.url), s.key, s.secret)
	if _, err := rs.DeleteRoom(context.Background(), &lkproto.DeleteRoomRequest{Room: room}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, media.ErrRoomClosed) {
			t.Fatalf("Run after the room was deleted: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not stop after the room was deleted")
	}
}

func TestSinkReachesAListenerAndIsFenced(t *testing.T) {
	s := liveKit(t)
	room := "it-out-" + time.Now().Format("150405.000")
	identity := "worker-w1"

	sink, err := NewSink(s.url, s.token(t, identity, &auth.VideoGrant{Room: room, CanPublish: yes(), CanSubscribe: no()}), "sk", 30*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- sink.Run(ctx) }()

	// A listener, subscribe-only, as Hono signs it.
	var heard atomic.Int64
	var name atomic.Value
	cb := lksdk.NewRoomCallback()
	cb.ParticipantCallback.OnTrackSubscribed = func(tr *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
		name.Store(pub.Name())
		_, err := lkmedia.NewPCMRemoteTrack(tr, pcmWriter{write: func(p msdk.PCM16Sample) {
			if loud(pcmBytes(p)) {
				heard.Add(int64(len(p)))
			}
		}}, lkmedia.WithTargetSampleRate(48000), lkmedia.WithTargetChannels(1))
		if err != nil {
			t.Errorf("listener decoder: %v", err)
		}
	}
	listener, err := lksdk.ConnectToRoomWithToken(s.url, s.token(t, "listener-1", &auth.VideoGrant{Room: room, CanSubscribe: yes(), CanPublish: no()}), cb)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Disconnect()

	// Gemini's translation arrives in bursts; play 3 s of it.
	phase := 0.0
	for range 150 {
		sink.Enqueue(pcmBytes(tone(audio.OutRate, &phase)))
	}
	deadline := time.Now().Add(10 * time.Second)
	for heard.Load() < 48000 && time.Now().Before(deadline) { // 1 s at 48 kHz
		time.Sleep(50 * time.Millisecond)
	}
	if heard.Load() < 48000 {
		t.Fatalf("listener heard %d loud samples", heard.Load())
	}
	if n, _ := name.Load().(string); n != "sk" {
		t.Fatalf("track name %q, want sk", n)
	}

	// A new owner joins with the same identity: this worker is fenced.
	other, err := lksdk.ConnectToRoomWithToken(s.url, s.token(t, identity, &auth.VideoGrant{Room: room, CanPublish: yes(), CanSubscribe: no()}), lksdk.NewRoomCallback())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Disconnect()
	select {
	case err := <-done:
		if !errors.Is(err, media.ErrReplaced) {
			t.Fatalf("Run after a duplicate identity: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not stop after a duplicate identity")
	}
}

func httpURL(ws string) string {
	switch {
	case len(ws) > 5 && ws[:5] == "ws://":
		return "http://" + ws[5:]
	case len(ws) > 6 && ws[:6] == "wss://":
		return "https://" + ws[6:]
	}
	return ws
}
