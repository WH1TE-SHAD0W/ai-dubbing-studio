// Package gemini runs one Gemini Live Translate stream for one target
// language: connecting, sending 16 kHz audio, receiving 24 kHz translated
// audio, and keeping the stream alive across GoAway and errors.
package gemini

import (
	"context"
	"errors"
	"time"
)

// Transcript is a fragment of the source or translated speech. The text is
// never logged unless LOG_TRANSCRIPTS is on (ADR-0002: transcripts are not kept).
type Transcript struct {
	Text         string
	Finished     bool
	LanguageCode string
}

// Event is what one server message carried. Several fields can be set at once.
type Event struct {
	// Audio is translated PCM16 mono audio at AudioRate.
	Audio     []byte
	AudioRate int
	// AudioMIME is the MIME type the server sent with the audio.
	AudioMIME    string
	Interrupted  bool
	TurnComplete bool
	// GoAway is set when the server will close the connection soon.
	GoAway *time.Duration
	// ResumeHandle is set when the server offers a new resumable handle.
	ResumeHandle string
	Input        *Transcript
	Output       *Transcript
}

// Session is one open connection to the Live API.
type Session interface {
	// SendAudio sends a chunk of PCM16 mono 16 kHz audio.
	SendAudio(pcm []byte) error
	// Recv blocks until the next server message. It returns an error once the
	// connection is closed, by either side.
	Recv() (Event, error)
	// Close closes the connection. It unblocks Recv and SendAudio.
	Close() error
}

// Connector opens sessions. resumeHandle is empty for a fresh session.
type Connector interface {
	Connect(ctx context.Context, lang, resumeHandle string) (Session, error)
}

// ErrConnectTimeout is returned when the server did not accept the setup in time.
var ErrConnectTimeout = errors.New("timed out connecting to Gemini")

// ErrRetriesExhausted is returned when the stream could not be (re)opened.
var ErrRetriesExhausted = errors.New("gemini: retries exhausted")
