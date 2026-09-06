param(
  [string]$InputFile,
  [string]$OutputFile
)

# =========================================================
# Convertor cântări -> songs.json
# Citeste un fisier text simplu si genereaza data/songs.json
# in formatul folosit de aplicatie.
#
# Folosire (din folderul church-project):
#   powershell -ExecutionPolicy Bypass -File tools/convert-songs.ps1
# sau cu fisiere custom:
#   powershell -ExecutionPolicy Bypass -File tools/convert-songs.ps1 -InputFile "cale\fisier.txt" -OutputFile "cale\songs.json"
#
# Format fisier text (vezi data/songs_TEMPLATE.txt):
#   ### Titlu cântare | Autor (optional)
#   @Strofa 1
#   primul rand al strofei
#   al doilea rand...
#   @Refren
#   ...
# =========================================================

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $here '..'

if (-not $InputFile)  { $InputFile  = Join-Path $project 'data\songs_TEMPLATE.txt' }
if (-not $OutputFile) { $OutputFile = Join-Path $project 'data\songs.json' }
$InputFile  = (Resolve-Path $InputFile).Path
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)

$lines = Get-Content -LiteralPath $InputFile -Encoding UTF8

$songs   = New-Object System.Collections.Generic.List[object]
$id      = 0
$song    = $null
$stanzaLabel = $null
$stanzaLines = New-Object System.Collections.Generic.List[string]
$inSong  = $false

function Flush-Stanza {
  if ($song -and $stanzaLabel) {
    $text = (($stanzaLines -join "`n")).TrimEnd()
    if ($text -ne '') {
      $song.stanzas.Add([pscustomobject]@{ type = $stanzaLabel; text = $text })
    }
  }
  $stanzaLines.Clear()
}

foreach ($raw in $lines) {
  $line = $raw.TrimEnd("`r")

  if ($line -match '^###\s*(.*)$') {
    # --- cântare nouă ---
    Flush-Stanza
    if ($song) { $songs.Add($song) }

    $header = $Matches[1].Trim()
    $parts = $header -split '\|', 2
    $title  = $parts[0].Trim()
    $author = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }

    $id++
    $song = [pscustomobject]@{
      id      = $id
      title   = $title
      author  = $author
      stanzas = (New-Object System.Collections.Generic.List[object])
    }
    $inSong = $true
  }
  elseif ($line -match '^@\s*(.*)$') {
    # --- strofă nouă în cântarea curentă ---
    if (-not $inSong) { continue }
    Flush-Stanza
    $stanzaLabel = $Matches[1].Trim()
  }
  elseif ($inSong -and $song) {
    # --- rând de text ---
    if ($line.Trim() -eq '') {
      if ($stanzaLines.Count -gt 0) { $stanzaLines.Add('') }
    } else {
      $stanzaLines.Add($line)
    }
  }
}

# flush final
Flush-Stanza
if ($song) { $songs.Add($song) }

if ($songs.Count -eq 0) {
  Write-Host "EROARE: nu am gasit nicio cantare (caut linii care incep cu '###')." -ForegroundColor Red
  exit 1
}

$json = $songs | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($OutputFile, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("GATA: " + $songs.Count + " cântări scrise in " + $OutputFile) -ForegroundColor Green
