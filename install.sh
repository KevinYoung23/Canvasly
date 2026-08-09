#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop, then run this file again."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required. Update Docker Desktop, then run this file again."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ "${1:-}" == "--copilot" ]]; then
  docker compose --profile copilot up --build -d
else
  docker compose up --build -d
fi

canvasly_port="$(sed -n 's/^CANVASLY_PORT=//p' .env | tail -1)"
canvasly_port="${canvasly_port:-4173}"
canvasly_url="http://localhost:${canvasly_port}"

echo ""
echo "Canvasly is ready: ${canvasly_url}"
echo ""

if command -v open >/dev/null 2>&1; then
  open "${canvasly_url}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${canvasly_url}" >/dev/null 2>&1 || true
fi
