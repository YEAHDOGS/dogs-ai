# Shared helpers, dot-sourced by every script. Windows PowerShell 5.1 and PowerShell 7 compatible.
$ErrorActionPreference = 'Stop'

$Repo     = Split-Path -Parent $PSScriptRoot
$Stack    = Get-Content (Join-Path $Repo 'stack.json') -Raw | ConvertFrom-Json
# One data folder per user, shared by every copy of DOGS AI on this computer (server/src/data-dir.mjs):
# %LOCALAPPDATA%\DOGS AI, or DOGS_AI_DATA. An older copy's runtime/ or outputs/ that has not moved there yet
# (the dogs server moves it when it next starts) is used where it is.
$Data = if ($env:DOGS_AI_DATA) { $env:DOGS_AI_DATA }
        elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'DOGS AI' }
        elseif ($IsMacOS) { Join-Path $HOME 'Library/Application Support/DOGS AI' }
        elseif ($env:XDG_DATA_HOME) { Join-Path $env:XDG_DATA_HOME 'dogs-ai' }
        else { Join-Path $HOME '.local/share/dogs-ai' }
function Get-DataPlace([string]$Name) {
  $shared = Join-Path $Data $Name
  $old = Join-Path $Repo $Name
  $has = { param($d) (Test-Path $d) -and @(Get-ChildItem -Force $d | Where-Object Name -ne '.gitkeep').Count -gt 0 }
  if (-not (& $has $shared) -and (& $has $old)) { return $old }
  return $shared
}
$Runtime  = Get-DataPlace 'runtime'
$ComfyDir = Join-Path $Runtime 'ComfyUI'
$FluxDir  = Join-Path $Runtime 'models\flux3-klein'
$Outputs  = Get-DataPlace 'outputs'
$ComfyUrl = "http://127.0.0.1:$($Stack.comfyui.port)"
$VenvPy   = Join-Path $ComfyDir '.venv\Scripts\python.exe'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    ok: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !! $msg" -ForegroundColor Yellow }

# Pick up PATH entries added by installers since this shell started (keeps the current entries).
function Update-SessionPath {
  $have = $env:Path -split ';'
  $new  = ([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' |
          Where-Object { $_ -and ($have -notcontains $_) }
  if ($new) { $env:Path = (@($have) + @($new)) -join ';' }
}

# Run a native command and fail loudly on a non-zero exit code.
function Exec([scriptblock]$block, [string]$what) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Update-SessionPath

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Test-Http($url) {
  try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false }
}

function Start-Ollama {
  if (Test-Http "$($Stack.ollama.host)/api/version") { return }
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) { if (Test-Http "$($Stack.ollama.host)/api/version") { return }; Start-Sleep 1 }
  throw 'Ollama did not start on ' + $Stack.ollama.host
}

function Start-ComfyUI {
  if (Test-Http "$ComfyUrl/system_stats") { Write-Ok "ComfyUI already running at $ComfyUrl"; return }
  New-Item -ItemType Directory -Force $Outputs | Out-Null
  $log = Join-Path $Runtime 'comfyui.log'
  $cargs = @('main.py') + $Stack.comfyui.args + @('--output-directory', "`"$Outputs`"", '--extra-model-paths-config', "`"$(Join-Path $Runtime 'extra_model_paths.yaml')`"")
  $p = Start-Process -FilePath $VenvPy -ArgumentList $cargs -WorkingDirectory $ComfyDir -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
  Set-Content (Join-Path $Runtime 'comfyui.pid') $p.Id
  for ($i = 0; $i -lt 180; $i++) {
    if (Test-Http "$ComfyUrl/system_stats") { Write-Ok "ComfyUI up at $ComfyUrl (pid $($p.Id))"; return }
    if ($p.HasExited) { throw "ComfyUI exited early, see $log.err" }
    Start-Sleep 1
  }
  throw "ComfyUI did not come up in 180s, see $log.err"
}
