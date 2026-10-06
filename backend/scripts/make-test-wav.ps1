# Generates a speech WAV in the format scripts/probe.ts needs (PCM16, mono, 16 kHz) using Windows' built-in
# text-to-speech, so the live Gemini check doesn't need a microphone.
#
#   powershell -File scripts/make-test-wav.ps1 [-Text "..."] [-Out test-speech.wav]
param(
  [string]$Text = 'Good morning everyone. Today we will discuss whether intentions matter more than outcomes. Let us start with a simple example.',
  [string]$Out = 'test-speech.wav'
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$path = Join-Path (Get-Location) $Out
$synth.SetOutputToWaveFile($path, $format)
$synth.Speak($Text)
$synth.Dispose()

$seconds = [math]::Round(((Get-Item $path).Length - 44) / 32000, 1)
"Wrote $path ($seconds s, PCM16 mono 16 kHz)"
