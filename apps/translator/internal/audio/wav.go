package audio

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// Format describes a WAV file's audio.
type Format struct {
	Rate     int
	Channels int
	Bits     int
}

// DecodeWAV returns the format and the PCM data of a WAV file.
func DecodeWAV(b []byte) (Format, []byte, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return Format{}, nil, errors.New("not a WAV file")
	}
	var f Format
	var haveFmt bool
	for i := 12; i+8 <= len(b); {
		id := string(b[i : i+4])
		size := int(binary.LittleEndian.Uint32(b[i+4 : i+8]))
		body := i + 8
		if body+size > len(b) {
			// Streams written without a final size (or truncated) still decode.
			size = len(b) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return Format{}, nil, errors.New("short fmt chunk")
			}
			if tag := binary.LittleEndian.Uint16(b[body : body+2]); tag != 1 {
				return Format{}, nil, fmt.Errorf("unsupported WAV encoding %d (need PCM)", tag)
			}
			f.Channels = int(binary.LittleEndian.Uint16(b[body+2 : body+4]))
			f.Rate = int(binary.LittleEndian.Uint32(b[body+4 : body+8]))
			f.Bits = int(binary.LittleEndian.Uint16(b[body+14 : body+16]))
			haveFmt = true
		case "data":
			if !haveFmt {
				return Format{}, nil, errors.New("data chunk before fmt chunk")
			}
			return f, b[body : body+size], nil
		}
		i = body + size + size%2
	}
	return Format{}, nil, errors.New("no data chunk")
}

// ReadPCM16Mono reads a WAV file and checks it is PCM16 mono at rate.
func ReadPCM16Mono(path string, rate int) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	f, pcm, err := DecodeWAV(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if f.Channels != 1 || f.Bits != 16 || f.Rate != rate {
		return nil, fmt.Errorf("%s: need PCM16 mono %d Hz, got %d ch %d bit %d Hz", path, rate, f.Channels, f.Bits, f.Rate)
	}
	return pcm, nil
}

// header returns a 44-byte PCM16 mono WAV header for dataLen bytes.
func header(rate int, dataLen uint32) []byte {
	h := make([]byte, 44)
	copy(h[0:], "RIFF")
	binary.LittleEndian.PutUint32(h[4:], 36+dataLen)
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1) // PCM
	binary.LittleEndian.PutUint16(h[22:], 1) // mono
	binary.LittleEndian.PutUint32(h[24:], uint32(rate))
	binary.LittleEndian.PutUint32(h[28:], uint32(rate*BytesPerSample))
	binary.LittleEndian.PutUint16(h[32:], BytesPerSample)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], dataLen)
	return h
}

// EncodeWAV returns a complete PCM16 mono WAV file.
func EncodeWAV(pcm []byte, rate int) []byte {
	return append(header(rate, uint32(len(pcm))), pcm...)
}

// WAVWriter streams PCM16 mono audio into a WAV file. Flush patches the
// header with the current length, so the file stays playable while it grows.
type WAVWriter struct {
	f    *os.File
	rate int
	n    int64
}

// CreateWAV creates (or truncates) path and writes an empty header.
func CreateWAV(path string, rate int) (*WAVWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(header(rate, 0)); err != nil {
		f.Close()
		return nil, err
	}
	return &WAVWriter{f: f, rate: rate}, nil
}

// Write appends PCM data.
func (w *WAVWriter) Write(pcm []byte) (int, error) {
	n, err := w.f.Write(pcm)
	w.n += int64(n)
	return n, err
}

// Len returns the number of PCM bytes written.
func (w *WAVWriter) Len() int64 { return w.n }

// Flush writes the current sizes into the header.
func (w *WAVWriter) Flush() error {
	size := uint32(min(w.n, int64(^uint32(0)-36)))
	if _, err := w.f.WriteAt(header(w.rate, size)[:44], 0); err != nil {
		return err
	}
	_, err := w.f.Seek(0, io.SeekEnd)
	return err
}

// Close flushes the header and closes the file.
func (w *WAVWriter) Close() error {
	ferr := w.Flush()
	cerr := w.f.Close()
	return errors.Join(ferr, cerr)
}
