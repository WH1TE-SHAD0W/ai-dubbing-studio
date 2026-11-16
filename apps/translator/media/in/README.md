# Input audio for the WAV adapter

When the API has no LiveKit settings, a worker reads the host's audio from a
WAV file here instead of the source room: `<language>.wav` if it exists (for example `sk.wav`), otherwise
`input.wav`. The file must be PCM16, mono, 16 kHz. It is streamed in real time,
followed by silence until the session ends.

Make one with Windows text-to-speech:

```powershell
powershell -File apps/translator/scripts/make-test-wav.ps1 -Out apps/translator/media/in/input.wav
```

Translated audio is written to `../out/<sessionId>-<language>-<workerId>.wav`.
WAV files in this folder are ignored by Git.
