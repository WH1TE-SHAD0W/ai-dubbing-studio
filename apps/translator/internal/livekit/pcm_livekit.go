//go:build livekit

package livekit

import (
	protoLogger "github.com/livekit/protocol/logger"
	lkmedia "github.com/livekit/server-sdk-go/v2/pkg/media"
	"github.com/pion/webrtc/v4"

	"github.com/WH1TE-SHAD0W/ai-dubbing-studio/apps/translator/internal/audio"
)

const supported = true

// newRemoteTrack decodes the host's Opus track to PCM16 mono at 16 kHz.
func newRemoteTrack(t *webrtc.TrackRemote, w pcmWriter) (remoteTrack, error) {
	rt, err := lkmedia.NewPCMRemoteTrack(t, w,
		lkmedia.WithTargetSampleRate(audio.InRate),
		lkmedia.WithTargetChannels(1),
		lkmedia.WithLogger(protoLogger.GetLogger()),
	)
	if err != nil {
		return nil, err
	}
	return rt, nil
}

// newLocalTrack encodes PCM16 mono at rate into an Opus track.
func newLocalTrack(rate int) (localTrack, error) {
	lt, err := lkmedia.NewPCMLocalTrack(rate, 1, protoLogger.GetLogger())
	if err != nil {
		return nil, err
	}
	return lt, nil
}
