<#
.SYNOPSIS
  Starts the whole ASTRA HEALTH demo with one command.

.DESCRIPTION
  1. Checks the setup (backend virtual environment, web packages, free ports).
  2. Creates the demo databases the first time (mission, 3 astronauts, demo accounts).
  3. Opens one window each for the Habitat backend (spacecraft), the Ground backend (Earth) and
     the web app, so you can watch their logs.
  4. Waits until all three answer, loads the simulated mission data (safe to repeat) and opens
     the browser.

  Works in Windows PowerShell 5.1 and PowerShell 7. If Windows blocks the script, run once:
      Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

.EXAMPLE
  .\start-demo.ps1
  Start everything (first run: also creates the databases).

.EXAMPLE
  .\start-demo.ps1 -Fresh
  Delete the demo databases and start again from mission day 121 (clears check-ins made during
  rehearsals).

.EXAMPLE
  .\start-demo.ps1 -Stop
  Close everything this script started.
#>
param(
  [switch]$Fresh,
  [switch]$Stop,
  [switch]$NoBrowser,
  [int]$MissionDay = 121,
  [int]$HabitatPort = 8000,
  [int]$GroundPort = 8001,
  [int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'services\backend'
$Web = Join-Path $Root 'apps\web'
$Python = Join-Path $Backend '.venv\Scripts\python.exe'
$PidFile = Join-Path $Root '.demo-pids'

function Say([string]$text, [string]$colour = 'Gray') { Write-Host $text -ForegroundColor $colour }

function Stop-Demo {
  if (-not (Test-Path $PidFile)) { Say 'Nothing to stop: no demo windows were started by this script.'; return }
  foreach ($id in Get-Content $PidFile) {
    if ($id -match '^\d+$') {
      # /T closes the whole tree: the window, the server and its reload workers
      & taskkill.exe /T /F /PID $id 2>$null | Out-Null
    }
  }
  Remove-Item $PidFile -Force
  Say 'Stopped the demo windows.' 'Green'
}

function Test-Url([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -lt 500
  } catch { return $false }
}

function Get-PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p) { return "$($p.ProcessName) (process $($p.Id))" }
  return "process $($c.OwningProcess)"
}

function Wait-Url([string]$name, [string]$url, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  Write-Host -NoNewline "  Waiting for $name "
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $url) { Say ' ready' 'Green'; return }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 1
  }
  Say ' not answering' 'Red'
  throw "$name did not start within $seconds s. Look at its window for the error."
}

# Opens a PowerShell window that runs $command in $dir; remembers it for -Stop.
function Start-DemoWindow([string]$title, [string]$dir, [string]$command) {
  $script = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location -LiteralPath '$dir'; $command"
  # passed encoded, so paths with spaces, commas or brackets survive
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $p = Start-Process powershell.exe -ArgumentList '-NoExit', '-NoProfile', '-EncodedCommand', $encoded -PassThru
  Add-Content -Path $PidFile -Value $p.Id
}

function New-Database([string]$file, [hashtable]$envVars) {
  Push-Location $Backend
  try {
    foreach ($k in $envVars.Keys) { Set-Item -Path "Env:$k" -Value $envVars[$k] }
    & $Python -m astra.seed --mission-day-today $MissionDay
    if ($LASTEXITCODE -ne 0) { throw "Creating $file failed." }
  } finally {
    foreach ($k in $envVars.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
    Pop-Location
  }
}

if ($Stop) { Stop-Demo; return }

Say ''
Say 'ASTRA HEALTH demo' 'Cyan'
Say '-----------------' 'Cyan'

# --- 1. setup checks --------------------------------------------------------------------------
if (-not (Test-Path $Python)) {
  Say 'The backend is not installed yet. Run once (see README, step 2):' 'Red'
  Say '  cd services/backend; uv venv --python 3.12 .venv; uv pip install --python .venv/Scripts/python.exe -e ".[dev]"'
  exit 1
}
if (-not (Test-Path (Join-Path $Web 'node_modules'))) {
  Say 'The web app is not installed yet. Run once:  cd apps/web; npm install' 'Red'
  exit 1
}
if (-not (Test-Path (Join-Path $Backend '.env'))) {
  Say 'Note: services/backend/.env is missing, so the demo runs without the NASA live data key and the Claude assistant (offline fallbacks are used).' 'Yellow'
}

if ($Fresh) {
  Stop-Demo
  foreach ($name in 'habitat', 'ground') {
    foreach ($ext in '.db', '.db-shm', '.db-wal') {
      $f = Join-Path $Backend "$name$ext"
      if (Test-Path $f) {
        try { Remove-Item $f -Force }
        catch {
          Say "Cannot delete ${name}${ext}: a server still has it open. Close the ASTRA backend windows (or terminals) first." 'Red'
          exit 1
        }
      }
    }
  }
  Say 'Deleted the demo databases; they will be created again.' 'Yellow'
}

$habitatUrl = "http://localhost:$HabitatPort"
$groundUrl = "http://localhost:$GroundPort"
$webUrl = "http://localhost:$WebPort"

# A port already in use is fine if it is our own server (e.g. started earlier); anything else stops here.
$start = @{}
foreach ($s in @(
    @{ Name = 'Habitat backend'; Port = $HabitatPort; Check = "$habitatUrl/health" },
    @{ Name = 'Ground backend'; Port = $GroundPort; Check = "$groundUrl/health" },
    @{ Name = 'Web app'; Port = $WebPort; Check = $webUrl })) {
  $owner = Get-PortOwner $s.Port
  if (-not $owner) { $start[$s.Name] = $true; continue }
  if (Test-Url $s.Check) {
    Say "  $($s.Name): already running on port $($s.Port), using it." 'Yellow'
    $start[$s.Name] = $false
  } else {
    Say "Port $($s.Port) ($($s.Name)) is taken by $owner, which is not part of the demo." 'Red'
    Say "Close it, or pick another port, e.g.  .\start-demo.ps1 -$($s.Name.Split(' ')[0])Port 9000" 'Red'
    exit 1
  }
}

# --- 2. databases (first run only) -------------------------------------------------------------
if (-not (Test-Path (Join-Path $Backend 'habitat.db'))) {
  Say "Creating the Habitat database (today = mission day $MissionDay)..."
  New-Database 'habitat.db' @{}
}
if (-not (Test-Path (Join-Path $Backend 'ground.db'))) {
  Say "Creating the Ground database (today = mission day $MissionDay)..."
  New-Database 'ground.db' @{ ASTRA_DATABASE_URL = 'sqlite:///ground.db' }
}

# --- 3. servers, each in its own window -------------------------------------------------------
$py = "& '.venv\Scripts\python.exe' -m uvicorn astra.main:app --reload"
if ($start['Habitat backend']) {
  Say "Starting the Habitat backend (spacecraft) on $habitatUrl"
  Start-DemoWindow 'ASTRA Habitat' $Backend "`$env:ASTRA_PEER_URL = '$groundUrl'; $py --port $HabitatPort"
}
if ($start['Ground backend']) {
  Say "Starting the Ground backend (Earth) on $groundUrl"
  Start-DemoWindow 'ASTRA Ground' $Backend ("`$env:ASTRA_NODE_ROLE = 'Ground'; `$env:ASTRA_NODE_ID = 'GND-MCC'; " +
    "`$env:ASTRA_DATABASE_URL = 'sqlite:///ground.db'; `$env:ASTRA_PEER_URL = '$habitatUrl'; $py --port $GroundPort")
}
if ($start['Web app']) {
  Say "Starting the web app on $webUrl"
  Start-DemoWindow 'ASTRA Web' $Web ("`$env:VITE_HABITAT_API = '$habitatUrl'; `$env:VITE_GROUND_API = '$groundUrl'; " +
    "npm run dev -- --port $WebPort --strictPort")
}

Wait-Url 'Habitat backend' "$habitatUrl/health" 120
Wait-Url 'Ground backend' "$groundUrl/health" 120
Wait-Url 'Web app' $webUrl 90

# --- 4. mission data (duplicates are skipped, so this is safe every time) ----------------------
Say 'Loading the simulated mission data (150 days, about 6,600 readings; quick when already loaded)...'
Push-Location $Root
try {
  & $Python 'simulator\simulate.py' seed --api $habitatUrl
  if ($LASTEXITCODE -ne 0) { throw 'Loading the mission data failed. See the output above.' }
} finally { Pop-Location }

Say ''
Say "Ready: $webUrl" 'Green'
Say ''
Say '  Sign in as         Password              Role'
Say '  ast1               astra-demo-ast1       Astronaut (start here: Daily check-in)'
Say '  surgeon1           astra-demo-surgeon    Flight surgeon (Earth)'
Say '  mission1           astra-demo-mission    Mission control'
Say '  admin              astra-demo-admin      Demo control: link, delay, scenarios, environment'
Say ''
Say 'Stop everything:  .\start-demo.ps1 -Stop      Start over:  .\start-demo.ps1 -Fresh'
Say ''
if (-not $NoBrowser) { Start-Process $webUrl }
