# Makes harness/audio/speech.wav (PCM16, mono, 16 kHz) with Windows' built-in
# text-to-speech, so the live-track scenario can send real speech to Gemini without a
# microphone. Adapted from main:backend/scripts/make-test-wav.ps1.
#
#   powershell -File benchmarks/runtime-test/harness/make-speech-wav.ps1
param(
  [string]$Text = @'
Good morning everyone, and thank you for joining us today. In this session we will look at how a small
team can run live translation for a large audience. The host speaks into a single microphone. Every listener
chooses a language on their phone, and a few seconds later they hear the talk in that language. Behind the
scenes, each language is handled by its own small worker. The worker listens to the host, sends the audio to
the translation model, and publishes the translated voice back into the room. When the talk ends, the worker
leaves, and a fresh one takes its place for the next session. Let us start with a simple example, and then
we will take your questions at the end.
'@,
  [string]$Out = (Join-Path $PSScriptRoot 'audio\speech.wav')
)

New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($Out, $format)
$synth.Speak($Text)
$synth.Dispose()

$seconds = [math]::Round(((Get-Item $Out).Length - 44) / 32000, 1)
"Wrote $Out ($seconds s, PCM16 mono 16 kHz)"
