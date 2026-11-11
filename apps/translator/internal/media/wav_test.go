package media

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
)

func TestInputPathPrefersLanguageFile(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "in"), 0o755)
	if _, err := InputPath(dir, "sk"); err == nil {
		t.Fatal("no input file, no error")
	}
	os.WriteFile(filepath.Join(dir, "in", "input.wav"), nil, 0o644)
	if p, _ := InputPath(dir, "sk"); filepath.Base(p) != "input.wav" {
		t.Fatalf("fallback %q", p)
	}
	os.WriteFile(filepath.Join(dir, "in", "sk.wav"), nil, 0o644)
	if p, _ := InputPath(dir, "sk"); filepath.Base(p) != "sk.wav" {
		t.Fatalf("language file %q", p)
	}
}

func TestWAVSourcePlaysInRealTimeThenSilence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "in.wav")
	pcm := make([]byte, audio.Bytes(audio.InRate, 100*time.Millisecond))
	for i := range pcm {
		pcm[i] = 1
	}
	os.WriteFile(path, audio.EncodeWAV(pcm, audio.InRate), 0o644)
	src, err := NewWAVSource(path)
	if err != nil {
		t.Fatal(err)
	}
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		var frames, loud int
		err := src.Run(ctx, func(f []byte) {
			frames++
			if len(f) != 640 {
				t.Errorf("frame of %d bytes", len(f))
			}
			if f[0] == 1 {
				loud++
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if frames < 9 || frames > 10 || loud != 5 {
			t.Fatalf("%d frames in 200 ms (%d from the file), want ~10 and 5", frames, loud)
		}
	})
}

func TestWAVSinkPacesAndPadsWithSilence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out", "s-sk-w.wav")
	synctest.Test(t, func(t *testing.T) {
		sink, err := NewWAVSink(path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- sink.Run(ctx) }()

		time.Sleep(100 * time.Millisecond) // nothing is written before the first audio
		sink.Enqueue(make([]byte, audio.Bytes(audio.OutRate, 50*time.Millisecond)))
		if sink.Buffered() != 50*time.Millisecond {
			t.Fatalf("buffered %v", sink.Buffered())
		}
		time.Sleep(200*time.Millisecond + time.Millisecond)
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		sink.Clear()
		if err := sink.Close(); err != nil {
			t.Fatal(err)
		}
	})
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, pcm, err := audio.DecodeWAV(b)
	if err != nil {
		t.Fatal(err)
	}
	// 200 ms of wall-clock time after the first audio = 10 frames of 20 ms.
	if got := audio.Duration(audio.OutRate, len(pcm)); got != 200*time.Millisecond {
		t.Fatalf("output covers %v, want 200ms", got)
	}
}
