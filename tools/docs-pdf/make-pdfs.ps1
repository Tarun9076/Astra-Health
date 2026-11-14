# Regenerates docs/pdf/*.pdf from docs/*.md (Mermaid diagrams included).
# Usage (from repo root):  cd tools/docs-pdf; npm install; npm run pdf
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Resolve-Path (Join-Path $here '..\..')
$docs = Join-Path $repo 'docs'
$outPdf = Join-Path $docs 'pdf'
$work = Join-Path $env:TEMP 'astra-docs-pdf'
$html = Join-Path $work 'html'

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }

New-Item -ItemType Directory -Force $outPdf, $html | Out-Null
Push-Location $here
try { node build.mjs $docs $html | Out-Null } finally { Pop-Location }

Get-ChildItem (Join-Path $html '*.html') | ForEach-Object {
  $url = 'file:///' + ($_.FullName -replace '\\', '/')
  $pdf = Join-Path $outPdf ($_.BaseName + '.pdf')
  Start-Process -FilePath $edge -Wait -NoNewWindow -ArgumentList @(
    '--headless', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
    '--virtual-time-budget=40000', "--user-data-dir=`"$work\edge-profile`"",
    "--print-to-pdf=`"$pdf`"", "`"$url`"") 2>$null
  Write-Host "PDF: $pdf"
}
