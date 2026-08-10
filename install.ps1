$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "Docker Desktop is required. Install it, then run this file again."
}

docker compose version | Out-Null

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

$copilotRequested = $args -contains "--copilot"
if ($copilotRequested) {
  $copilotToken = $env:COPILOT_GITHUB_TOKEN
  if ([string]::IsNullOrWhiteSpace($copilotToken)) {
    $tokenLine = Get-Content ".env" | Where-Object { $_ -match "^COPILOT_GITHUB_TOKEN=" } | Select-Object -Last 1
    $copilotToken = if ($tokenLine) { $tokenLine.Split("=", 2)[1] } else { "" }
  }
  if ([string]::IsNullOrWhiteSpace($copilotToken)) {
    Write-Error "The containerized Copilot bridge requires COPILOT_GITHUB_TOKEN in .env. For desktop login instead, run 'copilot login' and 'npm run copilot:bridge' on the host."
  }
  $privateEndpoints = $env:ALLOW_PRIVATE_LLM_ENDPOINTS
  if ([string]::IsNullOrWhiteSpace($privateEndpoints)) {
    $privateLine = Get-Content ".env" | Where-Object { $_ -match "^ALLOW_PRIVATE_LLM_ENDPOINTS=" } | Select-Object -Last 1
    $privateEndpoints = if ($privateLine) { $privateLine.Split("=", 2)[1] } else { "" }
  }
  if ($privateEndpoints -ne "true") {
    Write-Error "The Copilot profile requires ALLOW_PRIVATE_LLM_ENDPOINTS=true in .env."
  }
  docker compose --profile copilot up --build -d
} else {
  docker compose up --build -d
}

$portLine = Get-Content ".env" | Where-Object { $_ -match "^CANVASLY_PORT=" } | Select-Object -Last 1
$port = if ($portLine) { $portLine.Split("=", 2)[1] } else { "4173" }
$url = "http://localhost:$port"

Write-Host ""
Write-Host "Canvasly is ready: $url"
Write-Host ""
Start-Process $url
