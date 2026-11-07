package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func base() map[string]string {
	return map[string]string{
		"REDIS_URL":          "redis://localhost:6379",
		"CONTROL_API_URL":    "http://localhost:3000",
		"INTERNAL_API_TOKEN": "token",
		"GEMINI_API_KEY":     "key",
	}
}

func TestDefaults(t *testing.T) {
	c, err := Load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.JobStream != "translate:jobs" || c.JobGroup != "translators" {
		t.Errorf("stream/group = %q/%q", c.JobStream, c.JobGroup)
	}
	if c.GeminiModel != "gemini-3.5-live-translate-preview" || c.GeminiAPIVersion != "v1beta" || c.GeminiMaxRetries != 3 {
		t.Errorf("gemini defaults: %+v", c)
	}
	if c.InBuffer != 200*time.Millisecond || c.SendChunk != 100*time.Millisecond || c.MaxJob != 240*time.Minute {
		t.Errorf("timing defaults: %+v", c)
	}
	if c.HTTPAddr != ":8080" || c.MediaDir != "/media" {
		t.Errorf("addr/media: %q %q", c.HTTPAddr, c.MediaDir)
	}
}

func TestRequiredAndInvalid(t *testing.T) {
	m := base()
	delete(m, "GEMINI_API_KEY")
	m["REDIS_URL"] = "http://nope"
	m["SEND_CHUNK_MS"] = "30"
	m["LOG_LEVEL"] = "loud"
	_, err := Load(env(m))
	if err == nil {
		t.Fatal("invalid config accepted")
	}
	for _, want := range []string{"GEMINI_API_KEY is required", "REDIS_URL", "SEND_CHUNK_MS", "LOG_LEVEL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s:\n%v", want, err)
		}
	}
}

func TestWorkerIDIsUniquePerProcessStart(t *testing.T) {
	m := base()
	m["POD_NAME"] = "translator-1"
	a, _ := Load(env(m))
	b, _ := Load(env(m))
	if !strings.HasPrefix(a.WorkerID, "translator-1-") || len(a.WorkerID) != len("translator-1-")+6 {
		t.Fatalf("worker id %q", a.WorkerID)
	}
	if a.WorkerID == b.WorkerID {
		t.Fatal("two starts with the same hostname got the same worker id")
	}
	m["WORKER_ID"] = "fixed"
	c, _ := Load(env(m))
	if c.WorkerID != "fixed" {
		t.Fatalf("WORKER_ID override ignored: %q", c.WorkerID)
	}
}
