param(
  [ValidateSet("codex", "mock", "claude", "openai-compatible")]
  [string] $Provider = "codex",
  [string] $CodexCliPath = "codex",
  [string] $ClaudeCliPath = "claude",
  [int] $ApiPort = 4000,
  [int] $WebPort = 3000,
  [switch] $StopExisting,
  [switch] $SkipIndex
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot "tmp"
$catKbPath = Join-Path $repoRoot "knowledge-bases\cats"

function Write-Step {
  param([string] $Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-CommandExists {
  param([string] $Name)
  $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-PortProcessIds {
  param([int] $Port)
  $lines = netstat -ano | Select-String ":$Port\s"
  foreach ($line in $lines) {
    $parts = ($line.ToString().Trim() -split "\s+")
    if ($parts.Count -ge 5 -and $parts[3] -eq "LISTENING") {
      [int] $parts[4]
    }
  }
}

function Stop-PortListeners {
  param([int] $Port)
  $processIds = @(Get-PortProcessIds -Port $Port | Select-Object -Unique)
  foreach ($processId in $processIds) {
    Write-Step "Stopping process $processId on port $Port"
    Stop-Process -Id $processId -Force
  }
}

function Assert-PortAvailable {
  param([int] $Port)
  $processIds = @(Get-PortProcessIds -Port $Port | Select-Object -Unique)
  if ($processIds.Count -gt 0) {
    throw "Port $Port is already in use by process id(s): $($processIds -join ', '). Re-run with -StopExisting or stop those processes."
  }
}

function Start-DemoWindow {
  param(
    [string] $Title,
    [string] $Command
  )

  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  Start-Process powershell.exe -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", $encodedCommand
  ) -WorkingDirectory $repoRoot -WindowStyle Normal
  Write-Step "Started $Title"
}

function Wait-ForHttp {
  param(
    [string] $Url,
    [int] $TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-RestMethod $Url -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $Url"
}

if (-not (Test-CommandExists "npm")) {
  throw "npm was not found on PATH. Install Node.js 22+ and try again."
}

if ($Provider -eq "codex" -and -not (Test-CommandExists $CodexCliPath)) {
  throw "Codex CLI '$CodexCliPath' was not found on PATH. Pass -CodexCliPath or enable the Codex CLI first."
}

if ($Provider -eq "claude" -and -not (Test-CommandExists $ClaudeCliPath)) {
  throw "Claude CLI '$ClaudeCliPath' was not found on PATH. Pass -ClaudeCliPath or choose -Provider mock."
}

if ($Provider -eq "openai-compatible") {
  foreach ($name in @("OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL")) {
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      throw "$name is required when -Provider openai-compatible is selected."
    }
  }
}

if (-not (Test-Path $catKbPath)) {
  throw "Cat knowledge base not found at $catKbPath"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if ($StopExisting) {
  Stop-PortListeners -Port $ApiPort
  Stop-PortListeners -Port $WebPort
} else {
  Assert-PortAvailable -Port $ApiPort
  Assert-PortAvailable -Port $WebPort
}

$apiLog = Join-Path $logDir "cat-demo-api.log"
$watcherLog = Join-Path $logDir "cat-demo-watcher.log"
$webLog = Join-Path $logDir "cat-demo-web.log"

$apiCommand = @"
Set-Location '$repoRoot'
`$env:PORT = '$ApiPort'
`$env:AI_EXECUTION_MODE = 'queue'
Write-Host 'Markdown Magpie API: http://localhost:$ApiPort' -ForegroundColor Green
npm run dev:api *>&1 | Tee-Object -FilePath '$apiLog'
"@

$watcherCommand = @"
Set-Location '$repoRoot'
`$env:API_BASE_URL = 'http://localhost:$ApiPort'
`$env:AI_JOB_PROVIDER = '$Provider'
`$env:CODEX_CLI_PATH = '$CodexCliPath'
`$env:CODEX_CLI_ARGS = 'exec'
`$env:CODEX_CLI_PROMPT_MODE = 'arg'
`$env:CLAUDE_CLI_PATH = '$ClaudeCliPath'
`$env:CLAUDE_CLI_ARGS = '-p'
`$env:CLAUDE_CLI_PROMPT_MODE = 'arg'
`$env:OPENAI_COMPATIBLE_BASE_URL = '$env:OPENAI_COMPATIBLE_BASE_URL'
`$env:OPENAI_COMPATIBLE_API_KEY = '$env:OPENAI_COMPATIBLE_API_KEY'
`$env:OPENAI_COMPATIBLE_MODEL = '$env:OPENAI_COMPATIBLE_MODEL'
Write-Host 'Markdown Magpie watcher provider: $Provider' -ForegroundColor Green
npm run dev:watcher *>&1 | Tee-Object -FilePath '$watcherLog'
"@

$webCommand = @"
Set-Location '$repoRoot'
`$env:NEXT_PUBLIC_API_BASE_URL = 'http://localhost:$ApiPort'
Write-Host 'Markdown Magpie web: http://localhost:$WebPort' -ForegroundColor Green
npm run dev:web *>&1 | Tee-Object -FilePath '$webLog'
"@

Write-Step "Starting Markdown Magpie cat demo"
Start-DemoWindow -Title "API" -Command $apiCommand
Wait-ForHttp -Url "http://localhost:$ApiPort/health"

if (-not $SkipIndex) {
  Write-Step "Indexing cats knowledge base"
  $body = @{
    localPath = "knowledge-bases/cats"
    repositoryId = "cats"
    name = "Cats Knowledge Base"
  } | ConvertTo-Json
  Invoke-RestMethod "http://localhost:$ApiPort/repositories/index" -Method Post -ContentType "application/json" -Body $body | Out-Null
}

Start-DemoWindow -Title "Watcher" -Command $watcherCommand
Start-DemoWindow -Title "Web" -Command $webCommand

Write-Host ""
Write-Host "Demo is starting." -ForegroundColor Green
Write-Host "Open: http://localhost:$WebPort"
Write-Host "Ask: Why does my cat slow blink at me?"
Write-Host ""
Write-Host "Logs:"
Write-Host "  API:     $apiLog"
Write-Host "  Watcher: $watcherLog"
Write-Host "  Web:     $webLog"
