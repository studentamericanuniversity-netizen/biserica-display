param(
  [string]$DbDataDir = 'C:\Users\razva\Downloads\CANTARI_RESURSE_CRESTINE_Easyworship_7\Easyworship Profiles Export\Easyworship.v7\CANTARI_RESURSE_CRESTINE\CANTARI_RESURSE_CRESTINE Data\v6.1\Databases\Data',
  [string]$SqliteExe = 'C:\Users\razva\Desktop\harnes\church-project\tools\sqlite\sqlite3.exe',
  [string]$Output     = 'C:\Users\razva\Desktop\harnes\church-project\data\songs.json',
  [int]$Limit         = 0
)

# =========================================================
# Convertor EasyWorship 7 (SQLite) -> songs.json
# Citeste Songs.db + SongWords.db si extrage cantarile
# (titlu, autor, versuri din RTF -> strofe structurate).
# =========================================================

$ErrorActionPreference = 'Stop'
$dbSongs = Join-Path $DbDataDir 'Songs.db'
$dbWords = Join-Path $DbDataDir 'SongWords.db'
if (-not (Test-Path $dbSongs) -or -not (Test-Path $dbWords)) { throw "Nu am gasit Songs.db / SongWords.db in: $DbDataDir" }

$tmpDir = Join-Path (Split-Path $Output -Parent) '_tmp_convert'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

# --- decodare RTF -> text simplu ---
$cp1252 = $null
try { [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance) } catch {}
try { $cp1252 = [System.Text.Encoding]::GetEncoding(1252) } catch {}

function ConvertFrom-Rtf([string]$rtf) {
  if ([string]::IsNullOrEmpty($rtf)) { return '' }
  $s = Remove-RtfDestinations $rtf
  $s = [regex]::Replace($s, '\\u-?\d+\?', {
    param($m)
    $code = [int]([regex]::Match($m.Value, '-?\d+').Value)
    if ($code -lt 0) { $code += 65536 }
    if ($code -ge 0 -and $code -le 0xFFFF) { [string][char]$code } else { ' ' }
  })
  if ($cp1252) {
    $s = [regex]::Replace($s, "\\'([0-9a-fA-F]{2})", {
      param($m)
      try { $cp1252.GetString([byte[]]([Convert]::ToByte($m.Groups[1].Value, 16))) } catch { '?' }
    })
  } else {
    $s = [regex]::Replace($s, "\\'([0-9a-fA-F]{2})", ' ')
  }
  $s = [regex]::Replace($s, '\\par[d]?\s?', "`n")
  $s = [regex]::Replace($s, '\\line\s?', "`n")
  $s = $s -replace '\\tab', ' '
  $s = [regex]::Replace($s, '\\[a-zA-Z]*-?\d* ?', '')
  $s = $s -replace '[{}]', ''
  return $s
}

# Elimina grupurile RTF de definitii (fonttbl, colortbl, stylesheet, \*...)
# ca sa nu ramana gunoi (nume fonturi, marcaje) in textul cantecelor.
function Remove-RtfDestinations([string]$s) {
  $skipPattern = '^(fonttbl|colortbl|stylesheet|info|generator|filetbl|themedata|colorschememapping|listtable|listoverridetable|latentstyles|datastore|pict|object|revtbl|rsidtbl|mmathPr)$'
  $n = $s.Length
  $out = New-Object System.Text.StringBuilder($n)
  $i = 0
  while ($i -lt $n) {
    $ch = $s[$i]
    if ($ch -eq '{') {
      $j = $i + 1
      while ($j -lt $n -and ($s[$j] -eq ' ' -or $s[$j] -eq "`r" -or $s[$j] -eq "`n")) { $j++ }
      $skipGroup = $false
      if ($j -lt $n -and $s[$j] -eq '\') {
        $k = $j + 1
        if ($k -lt $n -and $s[$k] -eq '*') {
          $skipGroup = $true
        } else {
          $wStart = $k
          while ($k -lt $n -and $s[$k] -match '[a-zA-Z]') { $k++ }
          $word = $s.Substring($wStart, $k - $wStart)
          if ($word -match $skipPattern) { $skipGroup = $true }
        }
      }
      if ($skipGroup) {
        $depth = 0
        while ($i -lt $n) {
          if ($s[$i] -eq '{') { $depth++ }
          elseif ($s[$i] -eq '}') { $depth--; if ($depth -eq 0) { $i++; break } }
          $i++
        }
        continue
      }
    }
    [void]$out.Append($ch)
    $i++
  }
  return $out.ToString()
}

# --- eticheta strofei -> romana ---
function Get-StanzaType([string]$label) {
  $l = $label.Trim()
  if ($l -match '(?i)^vers')     { return ('Strofa ' + ([regex]::Replace($l, '(?i)^vers[ei]*\s*', '')).Trim()) }
  if ($l -match '(?i)^(chorus|cor|refren)') { return 'Refren' }
  if ($l -match '(?i)^(bridge|punte)') { return 'Punte' }
  if ($l -match '(?i)^(intro|introducere)') { return 'Intro' }
  if ($l -match '(?i)^(final|outro|sfarsit|sfârșit)') { return 'Final' }
  return $l
}

# --- stocare ---
$songs = New-Object System.Collections.Generic.List[object]

# limite de id
$maxId = [int](& $SqliteExe $dbSongs "SELECT MAX(rowid) FROM song;" 2>&1 | Select-Object -Last 1)
$upper = if ($Limit -gt 0) { [math]::Min($Limit, $maxId) } else { $maxId }
Write-Host "Max rowid: $maxId | convertesc pana la: $upper"

$chunk = 400
$done  = 0
for ($lo = 1; $lo -le $upper; $lo += $chunk) {
  $hi = [math]::Min($lo + $chunk - 1, $upper)
  $sql = "ATTACH '$($dbWords.Replace("'","''"))' AS wdb; SELECT s.rowid AS id, s.title AS title, COALESCE(s.author,'') AS author, w.words AS words FROM song s LEFT JOIN wdb.word w ON w.song_id = s.rowid WHERE s.rowid BETWEEN $lo AND $hi ORDER BY s.rowid;"
  $outFile = Join-Path $tmpDir "chunk_$lo.json"
  & $SqliteExe $dbSongs '.mode json' ('.output ' + $outFile) $sql '.output stdout' 2>&1 | Out-Null
  if (-not (Test-Path $outFile)) { continue }
  $raw = Get-Content -Raw -Encoding UTF8 $outFile
  Remove-Item $outFile -Force
  if ([string]::IsNullOrWhiteSpace($raw)) { continue }
  $rows = $raw | ConvertFrom-Json
  foreach ($r in $rows) {
    $plain = ConvertFrom-Rtf $r.words
    # separare in blocuri (strofe) pe linii goale
    $stanzas = New-Object System.Collections.Generic.List[object]
    $block = New-Object System.Collections.Generic.List[string]
    $labelLine = $null
    $pendingLabel = $false
    $lines = $plain -split "`n"
    $lineCount = $lines.Count
    for ($i = 0; $i -lt $lineCount; $i++) {
      $line = $lines[$i]
      if ($line.Trim() -ne '') {
        $clean = $line.Trim()
        # sar peste liniile-junk (doar simboluri, fara litere/cifre)
        if (([regex]::Replace($clean, '[^\p{L}\p{N}]', '')).Length -gt 0) { $block.Add($clean) }
        continue
      }
      # linie goala -> inchide blocul
      if ($block.Count -gt 0) {
        $isLabel = [regex]::IsMatch($block[0].Trim(), '(?i)^(vers[ei]*|v\d+|chorus|cor|refren|bridge|punte|intro|interludiu|final|outro|strof[aă]*)')
        if ($isLabel) {
          $lab = Get-StanzaType $block[0]
          $txtLines = @($block | Select-Object -Skip 1)
        } else {
          $lab = 'Strofa ' + ($stanzas.Count + 1)
          $txtLines = @($block)
        }
        $txt = (($txtLines -join "`n")).Trim()
        if ($txt -ne '') {
          $stanzas.Add([pscustomobject]@{ type = $lab; text = $txt })
        }
        $block.Clear()
      }
    }
    # ultimul bloc (fara linie goala la final)
    if ($block.Count -gt 0) {
      $isLabel = [regex]::IsMatch($block[0].Trim(), '(?i)^(vers[ei]*|v\d+|chorus|cor|refren|bridge|punte|intro|interludiu|final|outro|strof[aă]*)')
      if ($isLabel) {
        $lab = Get-StanzaType $block[0]
        $txtLines = @($block | Select-Object -Skip 1)
      } else {
        $lab = 'Strofa ' + ($stanzas.Count + 1)
        $txtLines = @($block)
      }
      $txt = (($txtLines -join "`n")).Trim()
      if ($txt -ne '') {
        $stanzas.Add([pscustomobject]@{ type = $lab; text = $txt })
      }
    }
    if ($stanzas.Count -eq 0) {
      # siguranta: daca nimic nu a iesit, pastram textul brut ca o singura strofa
      if ($plain.Trim() -ne '') {
        $stanzas.Add([pscustomobject]@{ type = 'Strofa 1'; text = $plain.Trim() })
      }
    }
    $songs.Add([pscustomobject]@{
      id      = $songs.Count + 1
      title   = ([string]$r.title).Trim()
      author  = ([string]$r.author).Trim()
      stanzas = $stanzas
    })
    $done++
  }
  if (($done % 2000) -lt $chunk) { Write-Host ("... " + $done + " cantari procesate") }
}

$outDir = Split-Path $Output -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$json = $songs | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Output, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "GATA: $($songs.Count) cantari -> $Output"
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
