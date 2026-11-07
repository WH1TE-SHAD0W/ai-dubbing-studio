package gemini_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/gemini"
)

// TestLiveTranslateWireProtocol runs the real SDK against a local WebSocket
// server and checks what goes over the wire: the setup message (Live
// Translate config) and the realtime audio input, then that server messages
// become events.
func TestLiveTranslateWireProtocol(t *testing.T) {
	type seen struct {
		path, key string
		setup     map[string]any
		input     map[string]any
	}
	got := make(chan seen, 1)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := seen{path: r.URL.Path, key: r.Header.Get("x-goog-api-key")}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer c.Close()
		if err := c.ReadJSON(&s.setup); err != nil {
			t.Error(err)
			return
		}
		c.WriteJSON(map[string]any{"setupComplete": map[string]any{}})
		if err := c.ReadJSON(&s.input); err != nil {
			t.Error(err)
			return
		}
		pcm := base64.StdEncoding.EncodeToString(make([]byte, 4800))
		c.WriteJSON(map[string]any{
			"serverContent": map[string]any{
				"modelTurn":           map[string]any{"parts": []any{map[string]any{"inlineData": map[string]any{"mimeType": "audio/pcm;rate=24000", "data": pcm}}}},
				"inputTranscription":  map[string]any{"text": "Good morning", "languageCode": "en"},
				"outputTranscription": map[string]any{"text": "Dobré ráno", "finished": true},
			},
		})
		c.WriteJSON(map[string]any{"sessionResumptionUpdate": map[string]any{"newHandle": "h-2", "resumable": true}})
		c.WriteJSON(map[string]any{"goAway": map[string]any{"timeLeft": "10s"}})
		got <- s
		// Keep the socket open until the client closes it.
		c.ReadMessage()
	}))
	defer srv.Close()

	ctx := context.Background()
	live, err := gemini.NewLive(ctx, gemini.LiveConfig{
		APIKey:     "test-key",
		Model:      "gemini-3.5-live-translate-preview",
		APIVersion: "v1beta",
		BaseURL:    "ws://" + strings.TrimPrefix(srv.URL, "http://"),
	})
	if err != nil {
		t.Fatal(err)
	}
	s, err := live.Connect(ctx, "sk", "h-1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SendAudio(make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}

	var events []gemini.Event
	for len(events) < 3 {
		e, err := s.Recv()
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, e)
	}
	w := <-got

	if !strings.HasSuffix(w.path, "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent") || w.key != "test-key" {
		t.Errorf("path %q key %q", w.path, w.key)
	}
	setup := w.setup["setup"].(map[string]any)
	if setup["model"] != "models/gemini-3.5-live-translate-preview" {
		t.Errorf("model %v", setup["model"])
	}
	gen := setup["generationConfig"].(map[string]any)
	tc := gen["translationConfig"].(map[string]any)
	if tc["targetLanguageCode"] != "sk" || tc["echoTargetLanguage"] != false {
		t.Errorf("translationConfig %v", tc)
	}
	if m := gen["responseModalities"].([]any); len(m) != 1 || m[0] != "AUDIO" {
		t.Errorf("responseModalities %v", m)
	}
	if setup["sessionResumption"].(map[string]any)["handle"] != "h-1" {
		t.Errorf("sessionResumption %v", setup["sessionResumption"])
	}
	if _, ok := setup["contextWindowCompression"].(map[string]any)["slidingWindow"]; !ok {
		t.Errorf("contextWindowCompression %v", setup["contextWindowCompression"])
	}
	for _, k := range []string{"inputAudioTranscription", "outputAudioTranscription"} {
		if _, ok := setup[k]; !ok {
			t.Errorf("setup misses %s", k)
		}
	}
	if _, ok := setup["systemInstruction"]; ok {
		t.Error("Live Translate takes no system instruction")
	}
	audio := w.input["realtimeInput"].(map[string]any)["audio"].(map[string]any)
	data, _ := base64.StdEncoding.DecodeString(audio["data"].(string))
	if audio["mimeType"] != "audio/pcm;rate=16000" || len(data) != 3200 {
		t.Errorf("realtime input mime %v, %d bytes", audio["mimeType"], len(data))
	}

	if e := events[0]; len(e.Audio) != 4800 || e.AudioRate != 24000 || e.Input == nil || e.Input.LanguageCode != "en" || e.Output == nil || !e.Output.Finished {
		t.Errorf("content event %+v", e)
	}
	if events[1].ResumeHandle != "h-2" {
		t.Errorf("resumption event %+v", events[1])
	}
	if events[2].GoAway == nil || *events[2].GoAway != 10*time.Second {
		t.Errorf("goAway event %+v", events[2])
	}
	b, _ := json.Marshal(setup)
	if strings.Contains(string(b), "test-key") {
		t.Error("API key leaked into the setup message")
	}
}

func TestConnectTimesOut(t *testing.T) {
	// A server that accepts the socket but never answers the setup.
	upgrader := websocket.Upgrader{}
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		<-release
	}))
	defer srv.Close()
	defer close(release)

	live, err := gemini.NewLive(context.Background(), gemini.LiveConfig{
		APIKey: "k", Model: "m", APIVersion: "v1beta",
		BaseURL:        "ws://" + strings.TrimPrefix(srv.URL, "http://"),
		ConnectTimeout: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := live.Connect(context.Background(), "sk", ""); err != gemini.ErrConnectTimeout {
		t.Fatalf("err %v, want ErrConnectTimeout", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("timeout not enforced")
	}
}
