package audio

import (
	"context"
	"sync"
	"sync/atomic"
)

// Chunker joins small frames into fixed-size chunks (20 ms frames into the
// 100 ms chunks Gemini's docs recommend).
type Chunker struct {
	size int
	buf  []byte
}

// NewChunker returns a chunker emitting chunks of size bytes.
func NewChunker(size int) *Chunker {
	return &Chunker{size: size, buf: make([]byte, 0, size*2)}
}

// Push adds b and returns every complete chunk. The returned slices are
// copies the caller may keep.
func (c *Chunker) Push(b []byte) [][]byte {
	c.buf = append(c.buf, b...)
	var out [][]byte
	for len(c.buf) >= c.size {
		chunk := make([]byte, c.size)
		copy(chunk, c.buf[:c.size])
		out = append(out, chunk)
		c.buf = append(c.buf[:0], c.buf[c.size:]...)
	}
	return out
}

// Pending returns the bytes waiting for a full chunk.
func (c *Chunker) Pending() int { return len(c.buf) }

// FrameQueue is a bounded queue of frames. Push never blocks: when the queue
// is full the oldest frame is dropped, so a stalled consumer loses old audio
// instead of growing memory or delaying fresh audio.
type FrameQueue struct {
	mu      sync.Mutex
	frames  [][]byte
	max     int
	notify  chan struct{}
	dropped atomic.Uint64
}

// NewFrameQueue returns a queue holding at most n frames (at least 1).
func NewFrameQueue(n int) *FrameQueue {
	return &FrameQueue{max: max(1, n), notify: make(chan struct{}, 1)}
}

// Push adds a copy of f, dropping the oldest frame if the queue is full.
func (q *FrameQueue) Push(f []byte) {
	cp := make([]byte, len(f))
	copy(cp, f)
	q.mu.Lock()
	if len(q.frames) >= q.max {
		q.frames = q.frames[1:]
		q.dropped.Add(1)
	}
	q.frames = append(q.frames, cp)
	q.mu.Unlock()
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// Pop waits for a frame or for ctx to end.
func (q *FrameQueue) Pop(ctx context.Context) ([]byte, error) {
	for {
		q.mu.Lock()
		if len(q.frames) > 0 {
			f := q.frames[0]
			q.frames = q.frames[1:]
			q.mu.Unlock()
			return f, nil
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, context.Cause(ctx)
		case <-q.notify:
		}
	}
}

// Len returns the number of queued frames.
func (q *FrameQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.frames)
}

// Dropped returns how many frames were dropped because the queue was full.
func (q *FrameQueue) Dropped() uint64 { return q.dropped.Load() }

// ByteBuffer is a bounded FIFO of bytes. Write never blocks: when it would
// exceed max, the oldest bytes are dropped (kept sample-aligned).
type ByteBuffer struct {
	mu      sync.Mutex
	buf     []byte
	max     int
	dropped atomic.Uint64
}

// NewByteBuffer returns a buffer holding at most n bytes.
func NewByteBuffer(n int) *ByteBuffer {
	n -= n % BytesPerSample
	return &ByteBuffer{max: max(BytesPerSample, n)}
}

// Write appends b, dropping the oldest bytes when full.
func (b *ByteBuffer) Write(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(p) >= b.max {
		b.dropped.Add(uint64(len(b.buf) + len(p) - b.max))
		b.buf = append(b.buf[:0], p[len(p)-b.max:]...)
		return
	}
	if over := len(b.buf) + len(p) - b.max; over > 0 {
		over += over % BytesPerSample
		b.dropped.Add(uint64(over))
		b.buf = b.buf[over:]
	}
	b.buf = append(b.buf, p...)
}

// Read removes and returns up to n bytes (sample-aligned).
func (b *ByteBuffer) Read(n int) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	n = min(n, len(b.buf))
	n -= n % BytesPerSample
	out := make([]byte, n)
	copy(out, b.buf[:n])
	b.buf = b.buf[n:]
	return out
}

// Len returns the buffered byte count.
func (b *ByteBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.buf)
}

// Reset drops everything buffered.
func (b *ByteBuffer) Reset() {
	b.mu.Lock()
	b.buf = b.buf[:0]
	b.mu.Unlock()
}

// Dropped returns how many bytes were dropped because the buffer was full.
func (b *ByteBuffer) Dropped() uint64 { return b.dropped.Load() }
