# Generates a two-speaker demo meeting with the Windows SAPI voices (David, Zira).
#   powershell -File scripts/make-demo-audio.ps1 [-Out test-audio]
# Writes lineN.wav (alternating speakers, for diarize-spike --lines) and meeting.wav
# (16 kHz mono 16-bit, for `pnpm smoke:meeting`). Synthetic speech, safe to share.
param([string]$Out = 'test-audio')

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path

$voices = @('Microsoft David Desktop', 'Microsoft Zira Desktop')
$script = @(
  'Good morning everyone. Let us start the weekly planning meeting.',
  'Thanks David. I finished the onboarding flow and it is ready for review.',
  'Great. Are there any blockers on the release for Friday?',
  'One. The Windows installer still fails when the notes folder is on a network drive.',
  'I can look at that today. I will also update the changelog.',
  'Perfect. Sarah, can you send the customer a status update after lunch?',
  'Yes, I will write it up and share it by two in the afternoon.',
  'Then we are done. Thanks everybody, see you next week.'
)

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

# Raw PCM from a WAV: skip the 44-byte header SAPI writes.
function Get-Pcm([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  $b[44..($b.Length - 1)]
}

$pcm = New-Object System.Collections.Generic.List[byte]
$gap = New-Object byte[] (16000 * 2 * 6 / 10) # 0.6 s of silence

for ($i = 0; $i -lt $script.Count; $i++) {
  $synth.SelectVoice($voices[$i % 2])
  $file = Join-Path $Out "line$i.wav"
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($script[$i])
  $synth.SetOutputToNull()
  $pcm.AddRange([byte[]](Get-Pcm $file))
  $pcm.AddRange($gap)
}

$meeting = Join-Path $Out 'meeting.wav'
$fs = [IO.File]::Create($meeting)
$w = New-Object IO.BinaryWriter($fs)
$w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $pcm.Count))
$w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $w.Write([int]16)
$w.Write([int16]1); $w.Write([int16]1); $w.Write([int]16000); $w.Write([int]32000)
$w.Write([int16]2); $w.Write([int16]16)
$w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$pcm.Count)
$w.Write($pcm.ToArray())
$w.Close()

"{0}: {1:N1}s, speakers alternate {2}" -f $meeting, ($pcm.Count / 32000), ($voices -join ' / ')
