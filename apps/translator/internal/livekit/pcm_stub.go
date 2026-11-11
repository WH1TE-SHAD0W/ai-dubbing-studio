//go:build !livekit

package livekit

import "github.com/pion/webrtc/v4"

// Without the livekit tag there is no Opus codec: NewSource and NewSink
// return ErrUnavailable before they get here.
const supported = false

func newRemoteTrack(*webrtc.TrackRemote, pcmWriter) (remoteTrack, error) {
	return nil, ErrUnavailable
}

func newLocalTrack(int) (localTrack, error) { return nil, ErrUnavailable }
