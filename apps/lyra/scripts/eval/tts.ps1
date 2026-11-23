# Renders eval lines with the Windows SAPI voices. Called by scripts/eval/tts.cjs:
#   powershell -NoProfile -File scripts/eval/tts.ps1 -Jobs <jobs.json>
# jobs.json is [{ "voice": "Microsoft David Desktop", "text": "...", "out": "C:\\...\\clip.wav" }].
# Output is 16 kHz mono 16-bit WAV, the format Lyra's pipeline reads.
param([Parameter(Mandatory = $true)][string]$Jobs)

Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

foreach ($job in (Get-Content -Raw $Jobs | ConvertFrom-Json)) {
  $synth.SelectVoice($job.voice)
  $synth.SetOutputToWaveFile($job.out, $fmt)
  if ($job.pitch) {
    # SSML lets one voice stand in for a second, similar-sounding person.
    $text = [Security.SecurityElement]::Escape($job.text)
    $synth.SpeakSsml("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
      "<prosody pitch='$($job.pitch)' rate='$($job.rate)'>$text</prosody></speak>")
  } else {
    $synth.Speak($job.text)
  }
  $synth.SetOutputToNull()
}
