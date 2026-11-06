// Package audio holds the pure PCM helpers the worker needs: WAV files,
// a chunker and bounded buffers. Audio is PCM16 little-endian mono, kept as
// []byte everywhere because both Gemini and WAV files take bytes.
package audio

import "time"

const (
	// InRate is the sample rate Gemini expects for input audio.
	InRate = 16000
	// OutRate is the sample rate of Gemini's translated audio.
	OutRate = 24000
	// BytesPerSample is the size of one PCM16 mono sample.
	BytesPerSample = 2
	// FrameDuration is the size of one media frame (LiveKit and the WAV source use 20 ms).
	FrameDuration = 20 * time.Millisecond
)

// Bytes returns how many bytes of PCM16 mono audio at rate cover d.
func Bytes(rate int, d time.Duration) int {
	return int(int64(rate)*int64(d)/int64(time.Second)) * BytesPerSample
}

// Duration returns how long n bytes of PCM16 mono audio at rate play.
func Duration(rate, n int) time.Duration {
	return time.Duration(int64(n/BytesPerSample) * int64(time.Second) / int64(rate))
}
