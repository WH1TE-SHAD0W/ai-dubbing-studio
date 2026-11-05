// Spike worker for ADR-0019: the idle state of a translator pod, written in Go.
//
// It does what a warm pod does while it waits for work (pod-spec §4.1 Idle):
//   - links and initialises the real SDKs (LiveKit, Gemini, Redis, Prometheus),
//   - serves /healthz, /readyz and /metrics on HTTP_ADDR,
//   - blocks on XREADGROUP for a job.
//
// When a job arrives, runJob does the real job path: join both rooms, open Gemini Live,
// pipe the host's audio through it and publish the result. The live-track scenario sends
// one job; the idle scenario sends none. The Node worker does the same steps.
package main

import (
	"context"
	"encoding/binary"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
	"github.com/livekit/media-sdk"
	protoLogger "github.com/livekit/protocol/logger"
	"github.com/pion/webrtc/v4"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"google.golang.org/genai"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var (
	log   = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ready atomic.Bool
	busy  = promauto.NewGauge(prometheus.GaugeOpts{Name: "translator_busy", Help: "1 while the pod holds a job."})

	samplesIn  = promauto.NewCounter(prometheus.CounterOpts{Name: "translator_samples_in_total", Help: "Host audio samples sent to Gemini."})
	samplesOut = promauto.NewCounter(prometheus.CounterOpts{Name: "translator_samples_out_total", Help: "Translated samples written to the out track."})
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	podName := env("POD_NAME", env("HOSTNAME", "worker-go"))
	stream := env("JOB_STREAM", "translate:jobs")
	group := env("JOB_GROUP", "translators")

	// The SDK clients a real pod creates at start-up. Neither one connects anywhere yet.
	// Idle runs pass no key; the client still needs one to be created.
	gem, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  env("GEMINI_API_KEY", "unused-while-idle"),
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		log.Error("gemini client", "err", err)
		os.Exit(1)
	}
	_ = lksdk.NewRoom(lksdk.NewRoomCallback())

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	mux.Handle("/metrics", promhttp.Handler())
	srv := &http.Server{Addr: env("HTTP_ADDR", ":8080"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http", "err", err)
			os.Exit(1)
		}
	}()

	opts, err := redis.ParseURL(env("REDIS_URL", "redis://redis:6379"))
	if err != nil {
		log.Error("redis url", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opts)
	if err := rdb.XGroupCreateMkStream(ctx, stream, group, "$").Err(); err != nil && !strings.HasPrefix(err.Error(), "BUSYGROUP") {
		log.Error("redis group", "err", err)
		os.Exit(1)
	}

	ready.Store(true)
	log.Info("ready", "pod", podName)

	for ctx.Err() == nil {
		res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: group, Consumer: podName, Streams: []string{stream, ">"}, Count: 1, Block: 5 * time.Second,
		}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Warn("xreadgroup", "err", err)
			time.Sleep(time.Second)
			continue
		}
		msg := res[0].Messages[0]
		rdb.XAck(ctx, stream, group, msg.ID)
		ready.Store(false)
		busy.Set(1)
		log.Info("job_received", "id", msg.ID)
		if err := runJob(ctx, gem, msg.Values); err != nil {
			log.Error("job", "err", err)
		}
		log.Info("ended")
		break // single-use pod: one job, then exit
	}

	rdb.XGroupDelConsumer(context.Background(), stream, group, podName)
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}

// runJob is the job path of pod-spec §3.1 and §4. The job carries the tokens itself (a
// spike shortcut for the /claim call of pod-spec §5.2).
func runJob(ctx context.Context, gem *genai.Client, job map[string]any) error {
	str := func(k string) string { s, _ := job[k].(string); return s }
	url, lang, host := str("livekitUrl"), str("language"), str("hostIdentity")

	out, err := lksdk.ConnectToRoomWithToken(url, str("outToken"), lksdk.NewRoomCallback())
	if err != nil {
		return err
	}
	defer out.Disconnect()
	track, err := lkmedia.NewPCMLocalTrack(24000, 1, protoLogger.GetLogger())
	if err != nil {
		return err
	}
	defer track.Close()
	if _, err := out.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: lang}); err != nil {
		return err
	}

	// Gemini Live Translate, configured as the prototype that ran against the real service
	// (main:backend/src/engine/gemini.ts). The Node worker sends the same config.
	echo := false
	sess, err := gem.Live.Connect(ctx, env("GEMINI_MODEL", "gemini-3.5-live-translate-preview"), &genai.LiveConnectConfig{
		ResponseModalities:       []genai.Modality{genai.ModalityAudio},
		TranslationConfig:        &genai.TranslationConfig{TargetLanguageCode: lang, EchoTargetLanguage: &echo},
		InputAudioTranscription:  &genai.AudioTranscriptionConfig{},
		OutputAudioTranscription: &genai.AudioTranscriptionConfig{},
		ContextWindowCompression: &genai.ContextWindowCompressionConfig{SlidingWindow: &genai.SlidingWindow{}},
		SessionResumption:        &genai.SessionResumptionConfig{},
	})
	if err != nil {
		return err
	}
	defer sess.Close()

	// Gemini → out room: translated 24 kHz PCM onto the published track.
	go func() {
		for {
			msg, err := sess.Receive()
			if err != nil {
				return
			}
			if msg.ServerContent == nil || msg.ServerContent.ModelTurn == nil {
				continue
			}
			for _, p := range msg.ServerContent.ModelTurn.Parts {
				if p.InlineData != nil {
					pcm := bytesToPCM(p.InlineData.Data)
					samplesOut.Add(float64(len(pcm)))
					_ = track.WriteSample(pcm)
				}
			}
		}
	}()

	// src room → Gemini: the host's audio only, as 16 kHz mono in 100 ms chunks.
	done := make(chan struct{})
	cb := lksdk.NewRoomCallback()
	subscribe := func(pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
		if rp.Identity() == host && pub.Kind() == lksdk.TrackKindAudio {
			_ = pub.SetSubscribed(true)
		}
	}
	cb.ParticipantCallback.OnTrackPublished = subscribe
	cb.ParticipantCallback.OnTrackSubscribed = func(t *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
		if _, err := lkmedia.NewPCMRemoteTrack(t, &geminiWriter{sess: sess},
			lkmedia.WithTargetSampleRate(16000), lkmedia.WithTargetChannels(1)); err != nil {
			log.Error("pcm remote track", "err", err)
			return
		}
		// Both rooms joined, host subscribed, Gemini open: the track is live (pod-spec D7).
		log.Info("live")
	}
	var once sync.Once
	cb.OnDisconnected = func() { once.Do(func() { close(done) }) }
	src, err := lksdk.ConnectToRoomWithToken(url, str("srcToken"), cb, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	defer src.Disconnect()
	// A host that published before we joined raises no OnTrackPublished: subscribe here.
	for _, rp := range src.GetRemoteParticipants() {
		for _, tp := range rp.TrackPublications() {
			if pub, ok := tp.(*lksdk.RemoteTrackPublication); ok {
				subscribe(pub, rp)
			}
		}
	}

	select {
	case <-ctx.Done():
	case <-done:
	}
	return nil
}

// geminiWriter collects 20 ms frames from the host track into 100 ms chunks for Gemini.
type geminiWriter struct {
	sess *genai.Session
	buf  []byte
}

func (w *geminiWriter) WriteSample(s media.PCM16Sample) error {
	for _, v := range s {
		w.buf = binary.LittleEndian.AppendUint16(w.buf, uint16(v))
	}
	if len(w.buf) < 3200 { // 100 ms at 16 kHz, 16-bit mono
		return nil
	}
	chunk := w.buf
	w.buf = nil
	samplesIn.Add(float64(len(chunk) / 2))
	return w.sess.SendRealtimeInput(genai.LiveRealtimeInput{
		Audio: &genai.Blob{Data: chunk, MIMEType: "audio/pcm;rate=16000"},
	})
}

func (w *geminiWriter) Close() error { return nil }

func bytesToPCM(b []byte) media.PCM16Sample {
	out := make(media.PCM16Sample, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return out
}
