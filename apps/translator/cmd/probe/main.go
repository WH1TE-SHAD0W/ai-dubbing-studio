// Command probe checks the real Gemini Live Translate API with a WAV file.
// It costs a little: it streams audio to Gemini for as long as it runs.
//
//	GEMINI_API_KEY=... go run ./cmd/probe -wav test-speech.wav -lang sk
//	GEMINI_API_KEY=... go run ./cmd/probe -wav test-speech.wav -lang sk -duration 13m   # long run: GoAway + resume
//
// The WAV must be PCM16 mono 16 kHz (scripts/make-test-wav.ps1 makes one).
// It reports what the docs don't say: time to first translated audio, the
// audio MIME type, how transcripts and resumption updates arrive, and whether
// a GoAway can be bridged by resuming on a new connection.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
)

func main() {
	wavPath := flag.String("wav", "test-speech.wav", "input WAV (PCM16 mono 16 kHz)")
	lang := flag.String("lang", "sk", "target language code")
	model := flag.String("model", envOr("GEMINI_MODEL", "gemini-3.5-live-translate-preview"), "model id")
	apiVersion := flag.String("api-version", envOr("GEMINI_API_VERSION", "v1beta"), "Live API version")
	duration := flag.Duration("duration", 0, "keep streaming (looping the WAV) for this long; 0 = play once")
	out := flag.String("out", "", "output WAV (default probe-out-<lang>.wav)")
	showText := flag.Bool("text", true, "print transcript text (first 40 fragments)")
	flag.Parse()

	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "set GEMINI_API_KEY")
		os.Exit(2)
	}
	if *out == "" {
		*out = "probe-out-" + *lang + ".wav"
	}
	pcm, err := audio.ReadPCM16Mono(*wavPath, audio.InRate)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Printf("input: %.1f s, target=%s, model=%s, api=%s\n", audio.Duration(audio.InRate, len(pcm)).Seconds(), *lang, *model, *apiVersion)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	conn, err := gemini.NewLive(ctx, gemini.LiveConfig{APIKey: key, Model: *model, APIVersion: *apiVersion})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	p := &probe{conn: conn, lang: *lang, showText: *showText}
	code := p.run(ctx, pcm, *duration)
	if len(p.out) > 0 {
		if err := os.WriteFile(*out, audio.EncodeWAV(p.out, p.outRate), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
		} else {
			fmt.Printf("wrote %s\n", *out)
		}
	}
	os.Exit(code)
}

type probe struct {
	conn     gemini.Connector
	lang     string
	showText bool

	mu       sync.Mutex
	cur      gemini.Session
	handle   string
	out      []byte
	outRate  int
	firstAt  time.Time
	mimes    map[string]int
	texts    int
	inLangs  map[string]int
	counts   map[string]int
	goAways  int
	resumes  int
	closeErr error
	sentAt   time.Time
	gen      atomic.Int64
}

func (p *probe) run(ctx context.Context, pcm []byte, duration time.Duration) int {
	p.mimes, p.inLangs, p.counts = map[string]int{}, map[string]int{}, map[string]int{}
	t0 := time.Now()
	s, err := p.conn.Connect(ctx, p.lang, "")
	if err != nil {
		fmt.Printf("could not connect after %d ms: %v\n", time.Since(t0).Milliseconds(), err)
		return 1
	}
	fmt.Printf("connected in %d ms\n", time.Since(t0).Milliseconds())
	p.cur = s
	go p.read(ctx, s, p.gen.Load())

	chunk := audio.Bytes(audio.InRate, 100*time.Millisecond)
	silence := make([]byte, chunk)
	end := time.Now().Add(duration)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	p.sentAt = time.Now()
	pos := 0
	trailing := 30 // 3 s of silence at the end so the model can finish
	for {
		var c []byte
		switch {
		case pos < len(pcm):
			c = pcm[pos:min(pos+chunk, len(pcm))]
			pos += chunk
		case duration > 0 && time.Now().Before(end):
			pos = 0
			continue
		case trailing > 0:
			c = silence
			trailing--
		default:
			goto done
		}
		select {
		case <-ctx.Done():
			goto done
		case <-tick.C:
		}
		p.mu.Lock()
		cur := p.cur
		p.mu.Unlock()
		if err := cur.SendAudio(c); err != nil {
			p.counts["sendError"]++
		}
	}
done:
	time.Sleep(3 * time.Second)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cur.Close()
	fmt.Println("---")
	if p.firstAt.IsZero() {
		fmt.Println("first translated audio: never")
	} else {
		fmt.Printf("first translated audio: %d ms after the first chunk\n", p.firstAt.Sub(p.sentAt).Milliseconds())
	}
	fmt.Printf("translated audio: %d bytes = %.1f s at %d Hz, MIME types %v\n", len(p.out), audio.Duration(max(p.outRate, 1), len(p.out)).Seconds(), p.outRate, p.mimes)
	fmt.Printf("message kinds: %v\n", p.counts)
	fmt.Printf("detected source languages: %v\n", p.inLangs)
	fmt.Printf("resume handle offered: %v; goAways: %d; resumed connections: %d\n", p.handle != "", p.goAways, p.resumes)
	if p.closeErr != nil {
		fmt.Printf("stream closed by server: %v\n", p.closeErr)
	}
	if len(p.out) == 0 {
		return 1
	}
	return 0
}

func (p *probe) read(ctx context.Context, s gemini.Session, gen int64) {
	for {
		e, err := s.Recv()
		if err != nil {
			p.mu.Lock()
			if gen == p.gen.Load() && ctx.Err() == nil {
				p.closeErr = err
			}
			p.mu.Unlock()
			return
		}
		p.handleEvent(ctx, e, gen)
	}
}

func (p *probe) handleEvent(ctx context.Context, e gemini.Event, gen int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	since := time.Since(p.sentAt).Milliseconds()
	if len(e.Audio) > 0 {
		if p.firstAt.IsZero() {
			p.firstAt = time.Now()
			fmt.Printf("  +%d ms  first audio: %d bytes, MIME %q\n", since, len(e.Audio), e.AudioMIME)
		}
		p.out = append(p.out, e.Audio...)
		p.outRate = e.AudioRate
		p.mimes[e.AudioMIME]++
		p.counts["audio"]++
	}
	if e.Interrupted {
		p.counts["interrupted"]++
	}
	if e.TurnComplete {
		p.counts["turnComplete"]++
	}
	if e.ResumeHandle != "" {
		p.handle = e.ResumeHandle
		p.counts["resumptionUpdate"]++
	}
	for kind, t := range map[string]*gemini.Transcript{"source": e.Input, "target": e.Output} {
		if t == nil {
			continue
		}
		p.counts[kind+"Transcript"]++
		if kind == "source" && t.LanguageCode != "" {
			p.inLangs[t.LanguageCode]++
		}
		if p.showText && p.texts < 40 {
			p.texts++
			fmt.Printf("  +%d ms  %-6s finished=%v lang=%q %q\n", since, kind, t.Finished, t.LanguageCode, t.Text)
		}
	}
	if e.GoAway != nil && gen == p.gen.Load() {
		p.goAways++
		fmt.Printf("  +%d ms  goAway, time left %v; opening a replacement with the resume handle (%v)\n", since, *e.GoAway, p.handle != "")
		go p.replace(ctx, gen)
	}
}

// replace opens a new session with the latest handle, swaps the sender to it
// and closes the old one shortly after (make-before-break).
func (p *probe) replace(ctx context.Context, gen int64) {
	p.mu.Lock()
	handle, old := p.handle, p.cur
	p.mu.Unlock()
	t0 := time.Now()
	s, err := p.conn.Connect(ctx, p.lang, handle)
	if err != nil {
		fmt.Printf("  replacement failed after %d ms: %v\n", time.Since(t0).Milliseconds(), err)
		return
	}
	p.mu.Lock()
	if !p.gen.CompareAndSwap(gen, gen+1) {
		p.mu.Unlock()
		s.Close()
		return
	}
	p.cur = s
	p.resumes++
	p.mu.Unlock()
	fmt.Printf("  replacement connected in %d ms (resumed=%v)\n", time.Since(t0).Milliseconds(), handle != "")
	go p.read(ctx, s, gen+1)
	time.Sleep(500 * time.Millisecond)
	if err := old.Close(); err != nil && !errors.Is(err, context.Canceled) {
		_ = err
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
