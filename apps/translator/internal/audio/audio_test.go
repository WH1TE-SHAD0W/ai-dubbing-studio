package audio

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBytesAndDuration(t *testing.T) {
	if got := Bytes(InRate, 100*time.Millisecond); got != 3200 {
		t.Fatalf("100 ms at 16 kHz = %d bytes, want 3200", got)
	}
	if got := Bytes(OutRate, FrameDuration); got != 960 {
		t.Fatalf("20 ms at 24 kHz = %d bytes, want 960", got)
	}
	if got := Duration(OutRate, 48000); got != time.Second {
		t.Fatalf("48000 bytes at 24 kHz = %v, want 1s", got)
	}
}

func TestChunkerJoinsFramesIntoChunks(t *testing.T) {
	c := NewChunker(3200)
	frame := bytes.Repeat([]byte{1}, 640)
	var chunks [][]byte
	for i := 0; i < 12; i++ {
		chunks = append(chunks, c.Push(frame)...)
	}
	if len(chunks) != 2 {
		t.Fatalf("12 frames of 20 ms gave %d chunks, want 2", len(chunks))
	}
	for _, ch := range chunks {
		if len(ch) != 3200 {
			t.Fatalf("chunk of %d bytes, want 3200", len(ch))
		}
	}
	if c.Pending() != 2*640 {
		t.Fatalf("pending %d, want %d", c.Pending(), 2*640)
	}
	// Chunks are copies: changing one doesn't touch the next.
	chunks[0][0] = 9
	if chunks[1][0] != 1 {
		t.Fatal("chunks share memory")
	}
}

func TestChunkerSplitsLargeInput(t *testing.T) {
	c := NewChunker(4)
	got := c.Push([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10})
	if len(got) != 2 || !bytes.Equal(got[1], []byte{5, 6, 7, 8}) || c.Pending() != 2 {
		t.Fatalf("got %v pending %d", got, c.Pending())
	}
}

func TestFrameQueueDropsOldest(t *testing.T) {
	q := NewFrameQueue(3)
	for i := byte(1); i <= 5; i++ {
		q.Push([]byte{i})
	}
	if q.Len() != 3 || q.Dropped() != 2 {
		t.Fatalf("len %d dropped %d, want 3 and 2", q.Len(), q.Dropped())
	}
	ctx := context.Background()
	for want := byte(3); want <= 5; want++ {
		f, err := q.Pop(ctx)
		if err != nil || f[0] != want {
			t.Fatalf("pop = %v, %v; want [%d]", f, err, want)
		}
	}
}

func TestFrameQueuePopWaitsAndCancels(t *testing.T) {
	q := NewFrameQueue(2)
	go func() {
		time.Sleep(10 * time.Millisecond)
		q.Push([]byte{7})
	}()
	f, err := q.Pop(context.Background())
	if err != nil || f[0] != 7 {
		t.Fatalf("pop = %v, %v", f, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := q.Pop(ctx); err == nil {
		t.Fatal("pop on a cancelled context returned no error")
	}
}

func TestByteBufferBoundedDropOldest(t *testing.T) {
	b := NewByteBuffer(8)
	b.Write([]byte{1, 1, 2, 2, 3, 3})
	b.Write([]byte{4, 4, 5, 5})
	if b.Len() != 8 || b.Dropped() != 2 {
		t.Fatalf("len %d dropped %d", b.Len(), b.Dropped())
	}
	if got := b.Read(3); !bytes.Equal(got, []byte{2, 2}) {
		t.Fatalf("read(3) = %v, want sample-aligned [2 2]", got)
	}
	b.Write(bytes.Repeat([]byte{9}, 20))
	if b.Len() != 8 {
		t.Fatalf("len after oversize write %d, want 8", b.Len())
	}
	b.Reset()
	if b.Len() != 0 {
		t.Fatal("reset left data")
	}
}

func TestWAVRoundTrip(t *testing.T) {
	pcm := []byte{1, 0, 2, 0, 3, 0, 4, 0}
	f, got, err := DecodeWAV(EncodeWAV(pcm, OutRate))
	if err != nil {
		t.Fatal(err)
	}
	if f != (Format{Rate: OutRate, Channels: 1, Bits: 16}) || !bytes.Equal(got, pcm) {
		t.Fatalf("format %+v data %v", f, got)
	}
}

func TestWAVWriterKeepsFilePlayableWhileGrowing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.wav")
	w, err := CreateWAV(path, OutRate)
	if err != nil {
		t.Fatal(err)
	}
	w.Write(make([]byte, 960))
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	w.Write(make([]byte, 960))
	b, _ := os.ReadFile(path)
	// After a flush the header says 960; the extra bytes are still read.
	if _, pcm, err := DecodeWAV(b); err != nil || len(pcm) != 960 {
		t.Fatalf("mid-write decode: %d bytes, %v", len(pcm), err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if _, pcm, err := DecodeWAV(b); err != nil || len(pcm) != 1920 {
		t.Fatalf("final decode: %d bytes, %v", len(pcm), err)
	}
}

func TestReadPCM16MonoRejectsWrongFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "in.wav")
	os.WriteFile(path, EncodeWAV(make([]byte, 100), OutRate), 0o644)
	if _, err := ReadPCM16Mono(path, InRate); err == nil {
		t.Fatal("a 24 kHz file was accepted as 16 kHz")
	}
	if _, _, err := DecodeWAV([]byte("not a wav")); err == nil {
		t.Fatal("garbage decoded")
	}
}
