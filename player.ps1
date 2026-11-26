Add-Type -AssemblyName PresentationCore
$ErrorActionPreference = "Stop"
$p = New-Object System.Windows.Media.MediaPlayer
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $sp = $line.IndexOf(' ')
  if ($sp -lt 0) { $c = $line.ToUpper(); $a = "" } else { $c = $line.Substring(0, $sp).ToUpper(); $a = $line.Substring($sp + 1) }
  switch ($c) {
    "PLAY" {
      try { $p.Open([Uri]$a); Start-Sleep -Milliseconds 700; $p.Play(); "OK PLAY" }
      catch { "ERR " + $_.Exception.Message }
    }
    "PAUSE"  { $p.Pause(); "OK PAUSE" }
    "RESUME" { $p.Play(); "OK RESUME" }
    "STOP"   { $p.Stop(); $p.Close(); "OK STOP" }
    "VOL"    { $p.Volume = [double]$a; "OK VOL" }
    "STATUS" {
      $dur = 0; $pos = 0
      try { if ($p.NaturalDuration.HasTimeSpan) { $dur = [Math]::Round($p.NaturalDuration.TimeSpan.TotalSeconds, 2) } } catch {}
      try { $pos = [Math]::Round($p.Position.TotalSeconds, 2) } catch {}
      "STATUS $pos $dur"
    }
    "QUIT"   { $p.Close(); "OK QUIT"; break }
    default  { "ERR unknown" }
  }
}
