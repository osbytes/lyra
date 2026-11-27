# Reads the text in each image with the OCR engine built into Windows (Windows.Media.Ocr), so the
# Zoom eval (zoom-video.cjs) needs nothing installed. Windows PowerShell 5.1 only: PowerShell 7
# can't load WinRT types.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File zoom-ocr.ps1 a.png b.png ...
#
# Prints one JSON object per line: {"path": "...", "text": "..."}.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT calls are async; this waits on one through the .NET bridge.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-Async($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait() | Out-Null
  $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'no OCR language installed (Settings > Time & language > Language)' }

foreach ($path in $Paths) {
  $file = Wait-Async ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $path).Path)) ([Windows.Storage.StorageFile])
  $stream = Wait-Async ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Wait-Async ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Wait-Async ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Wait-Async ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    # ConvertTo-Json in 5.1 leaves control characters unescaped, which breaks the JSON.
    $text = (($result.Lines | ForEach-Object { $_.Text }) -join ' ') -replace '\p{Cc}', ' '
  } finally {
    $stream.Dispose()
  }
  [Console]::Out.WriteLine((@{ path = $path; text = $text } | ConvertTo-Json -Compress))
}
