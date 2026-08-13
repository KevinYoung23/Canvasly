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

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but its daemon is not running."
  echo "Start Docker Desktop, wait until it reports that Docker is running, then run this file again."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

if [[ "${1:-}" == "--copilot" ]]; then
  copilot_token="${COPILOT_GITHUB_TOKEN:-}"
  if [[ -z "${copilot_token}" ]]; then
    copilot_token="$(sed -n 's/^COPILOT_GITHUB_TOKEN=//p' .env | tail -1)"
  fi
  if [[ -z "${copilot_token}" ]]; then
    echo "The containerized Copilot bridge requires COPILOT_GITHUB_TOKEN in .env."
    echo "For desktop login instead, run 'copilot login' and 'npm run copilot:bridge' on the host."
    exit 1
  fi
  private_endpoints="${ALLOW_PRIVATE_LLM_ENDPOINTS:-}"
  if [[ -z "${private_endpoints}" ]]; then
    private_endpoints="$(sed -n 's/^ALLOW_PRIVATE_LLM_ENDPOINTS=//p' .env | tail -1)"
  fi
  if [[ "${private_endpoints}" != "true" ]]; then
    echo "The Copilot profile requires ALLOW_PRIVATE_LLM_ENDPOINTS=true in .env."
    exit 1
  fi
  docker compose --profile copilot up --build -d --wait --wait-timeout 300
else
  docker compose up --build -d --wait --wait-timeout 300
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
