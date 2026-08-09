$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "Docker Desktop is required. Install it, then run this file again."
}

docker compose version | Out-Null

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

if ($args -contains "--copilot") {
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
