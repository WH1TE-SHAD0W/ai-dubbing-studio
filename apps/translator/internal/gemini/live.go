package gemini

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"google.golang.org/genai"
)

// InputMIME is the MIME type of the audio we send.
const InputMIME = "audio/pcm;rate=16000"

// LiveConfig configures the real Gemini connector.
type LiveConfig struct {
	APIKey     string
	Model      string
	APIVersion string
	// BaseURL overrides the API endpoint (tests point it at a local server).
	BaseURL        string
	ConnectTimeout time.Duration
}

// Live opens Gemini Live Translate sessions through the official SDK.
type Live struct {
	client  *genai.Client
	cfg     LiveConfig
	timeout time.Duration
}

// NewLive returns a connector for the Gemini API backend.
func NewLive(ctx context.Context, cfg LiveConfig) (*Live, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("gemini: API key is empty")
	}
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  cfg.APIKey,
		Backend: genai.BackendGeminiAPI,
		HTTPOptions: genai.HTTPOptions{
			APIVersion: cfg.APIVersion,
			BaseURL:    cfg.BaseURL,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("gemini: %s", scrub(err.Error(), cfg.APIKey))
	}
	timeout := cfg.ConnectTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Live{client: client, cfg: cfg, timeout: timeout}, nil
}

// ConnectConfig is the Live Translate setup for one target language.
func ConnectConfig(lang, resumeHandle string) *genai.LiveConnectConfig {
	echo := false
	return &genai.LiveConnectConfig{
		ResponseModalities:       []genai.Modality{genai.ModalityAudio},
		InputAudioTranscription:  &genai.AudioTranscriptionConfig{},
		OutputAudioTranscription: &genai.AudioTranscriptionConfig{},
		TranslationConfig: &genai.TranslationConfig{
			TargetLanguageCode: lang,
			EchoTargetLanguage: &echo,
		},
		// Without compression an audio-only session is capped at about 15 minutes.
		ContextWindowCompression: &genai.ContextWindowCompressionConfig{SlidingWindow: &genai.SlidingWindow{}},
		SessionResumption:        &genai.SessionResumptionConfig{Handle: resumeHandle},
	}
}

// Connect opens a session. The SDK's Connect ignores ctx while dialling and
// waits for the server's setup reply, so it is bounded here by a timer; a
// session that arrives after we gave up is closed in the background.
func (l *Live) Connect(ctx context.Context, lang, resumeHandle string) (Session, error) {
	type result struct {
		s   *genai.Session
		err error
	}
	ch := make(chan result, 1)
	go func() {
		s, err := l.client.Live.Connect(ctx, l.cfg.Model, ConnectConfig(lang, resumeHandle))
		ch <- result{s, err}
	}()
	lateClose := func() {
		if r := <-ch; r.s != nil {
			r.s.Close()
		}
	}
	timer := time.NewTimer(l.timeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, fmt.Errorf("gemini connect: %s", scrub(r.err.Error(), l.cfg.APIKey))
		}
		return &liveSession{s: r.s, key: l.cfg.APIKey, skipSetup: true}, nil
	case <-timer.C:
		go lateClose()
		return nil, ErrConnectTimeout
	case <-ctx.Done():
		go lateClose()
		return nil, context.Cause(ctx)
	}
}

type liveSession struct {
	s   *genai.Session
	key string
	// The SDK keeps the setupComplete message and returns it from the first
	// Receive; it carries nothing we need.
	skipSetup bool
}

func (l *liveSession) SendAudio(pcm []byte) error {
	err := l.s.SendRealtimeInput(genai.LiveRealtimeInput{Audio: &genai.Blob{Data: pcm, MIMEType: InputMIME}})
	if err != nil {
		return errors.New(scrub(err.Error(), l.key))
	}
	return nil
}

func (l *liveSession) Recv() (Event, error) {
	for {
		m, err := l.s.Receive()
		if err != nil {
			return Event{}, errors.New(scrub(err.Error(), l.key))
		}
		if l.skipSetup {
			l.skipSetup = false
			if m.SetupComplete != nil && m.ServerContent == nil {
				continue
			}
		}
		return ToEvent(m), nil
	}
}

func (l *liveSession) Close() error { return l.s.Close() }

// ToEvent converts a server message into an Event.
func ToEvent(m *genai.LiveServerMessage) Event {
	var e Event
	if sc := m.ServerContent; sc != nil {
		if sc.ModelTurn != nil {
			for _, p := range sc.ModelTurn.Parts {
				if p == nil || p.InlineData == nil || len(p.InlineData.Data) == 0 {
					continue
				}
				mime := p.InlineData.MIMEType
				if mime != "" && !strings.HasPrefix(mime, "audio/") {
					continue
				}
				e.Audio = append(e.Audio, p.InlineData.Data...)
				e.AudioMIME = mime
				e.AudioRate = rateFromMIME(mime, 24000)
			}
		}
		e.Interrupted = sc.Interrupted
		e.TurnComplete = sc.TurnComplete
		e.Input = transcript(sc.InputTranscription)
		e.Output = transcript(sc.OutputTranscription)
	}
	if g := m.GoAway; g != nil {
		left := g.TimeLeft
		e.GoAway = &left
	}
	if u := m.SessionResumptionUpdate; u != nil && u.Resumable && u.NewHandle != "" {
		e.ResumeHandle = u.NewHandle
	}
	return e
}

func transcript(t *genai.Transcription) *Transcript {
	if t == nil || t.Text == "" {
		return nil
	}
	return &Transcript{Text: t.Text, Finished: t.Finished, LanguageCode: t.LanguageCode}
}

// rateFromMIME reads "rate=N" from a MIME type like "audio/pcm;rate=24000".
func rateFromMIME(mime string, fallback int) int {
	for _, part := range strings.Split(mime, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(k, "rate") {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return n
			}
		}
	}
	return fallback
}

// scrub removes the API key from error text before it is logged.
func scrub(text, key string) string {
	if key == "" {
		return text
	}
	return strings.ReplaceAll(text, key, "***")
}
