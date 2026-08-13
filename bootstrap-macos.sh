#!/usr/bin/env bash
set -euo pipefail

repository="KevinYoung23/Canvasly"
project_dir="${CANVASLY_PROJECT_DIR:-${HOME}/Canvasly}"
ref="${CANVASLY_REF:-main}"
copilot_requested=false
temporary_dir=""
docker_mount=""
docker_cli=""

usage() {
  cat <<'EOF'
Install Canvasly and Docker Desktop on macOS.

Usage:
  bash bootstrap-macos.sh [--project-dir PATH] [--ref GIT_REF] [--copilot]

Options:
  --project-dir PATH  Install Canvasly here (default: ~/Canvasly).
  --ref GIT_REF       Download this branch (default: main).
  --copilot           Start the optional containerized Copilot bridge.
  -h, --help          Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      if [[ $# -lt 2 ]]; then
        echo "--project-dir requires a path." >&2
        exit 1
      fi
      project_dir="$2"
      shift 2
      ;;
    --ref)
      if [[ $# -lt 2 ]]; then
        echo "--ref requires a Git ref." >&2
        exit 1
      fi
      ref="$2"
      shift 2
      ;;
    --copilot)
      copilot_requested=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap installer supports macOS only." >&2
  echo "On Linux, download Canvasly and run bash ./install.sh instead." >&2
  exit 1
fi

if [[ ! "${ref}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "The Git ref contains unsupported characters: ${ref}" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${docker_mount}" && -d "${docker_mount}" ]]; then
    hdiutil detach "${docker_mount}" -quiet >/dev/null 2>&1 || true
  fi
  if [[ -n "${temporary_dir}" && -d "${temporary_dir}" ]]; then
    rm -rf "${temporary_dir}"
  fi
}
trap cleanup EXIT

log() {
  printf '\n[Canvasly] %s\n' "$1"
}

is_canvasly_project() {
  [[ -f "$1/compose.yaml" && -f "$1/install.sh" && -f "$1/package.json" ]]
}

ensure_temporary_dir() {
  if [[ -z "${temporary_dir}" ]]; then
    temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/canvasly-bootstrap.XXXXXX")"
  fi
}

download_canvasly() {
  if is_canvasly_project "${project_dir}"; then
    log "Using the existing Canvasly project at ${project_dir}"
    return
  fi

  if [[ -e "${project_dir}" ]]; then
    echo "The install location already exists but is not a Canvasly project:" >&2
    echo "  ${project_dir}" >&2
    echo "Move or rename that folder, then run this installer again." >&2
    exit 1
  fi

  ensure_temporary_dir
  local archive="${temporary_dir}/canvasly.tar.gz"
  local extracted="${temporary_dir}/canvasly"
  local archive_url="https://codeload.github.com/${repository}/tar.gz/refs/heads/${ref}"

  log "Downloading Canvasly"
  curl --fail --location --retry 3 --connect-timeout 20 \
    "${archive_url}" \
    --output "${archive}"

  mkdir -p "${extracted}"
  tar -xzf "${archive}" -C "${extracted}" --strip-components=1
  if ! is_canvasly_project "${extracted}"; then
    echo "The downloaded archive is not a valid Canvasly project." >&2
    exit 1
  fi

  mkdir -p "$(dirname "${project_dir}")"
  mv "${extracted}" "${project_dir}"
  log "Canvasly was installed at ${project_dir}"
}

find_docker_app() {
  if [[ -d "/Applications/Docker.app" ]]; then
    printf '%s\n' "/Applications/Docker.app"
  elif [[ -d "${HOME}/Applications/Docker.app" ]]; then
    printf '%s\n' "${HOME}/Applications/Docker.app"
  else
    return 1
  fi
}

find_docker_cli() {
  if command -v docker >/dev/null 2>&1; then
    command -v docker
  elif [[ -x "/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
    printf '%s\n' "/Applications/Docker.app/Contents/Resources/bin/docker"
  elif [[ -x "${HOME}/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
    printf '%s\n' "${HOME}/Applications/Docker.app/Contents/Resources/bin/docker"
  elif [[ -x "${HOME}/.docker/bin/docker" ]]; then
    printf '%s\n' "${HOME}/.docker/bin/docker"
  else
    return 1
  fi
}

install_docker_desktop() {
  local docker_url
  case "$(uname -m)" in
    arm64)
      docker_url="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
      ;;
    x86_64)
      docker_url="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
      ;;
    *)
      echo "Docker Desktop does not support this Mac architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac

  ensure_temporary_dir
  local docker_dmg="${temporary_dir}/Docker.dmg"
  docker_mount="${temporary_dir}/docker-volume"
  mkdir -p "${docker_mount}"

  log "Downloading Docker Desktop from docker.com"
  curl --fail --location --retry 3 --connect-timeout 20 \
    "${docker_url}" \
    --output "${docker_dmg}"

  log "Installing Docker Desktop (macOS will ask for your password)"
  hdiutil attach "${docker_dmg}" -nobrowse -quiet -mountpoint "${docker_mount}"
  codesign --verify --deep --strict "${docker_mount}/Docker.app"
  spctl --assess --type execute "${docker_mount}/Docker.app"
  sudo "${docker_mount}/Docker.app/Contents/MacOS/install" --user="${USER}"
  hdiutil detach "${docker_mount}" -quiet
  docker_mount=""
}

wait_for_docker() {
  local docker_app=""
  local attempt=0

  docker_cli="$(find_docker_cli || true)"
  if [[ -n "${docker_cli}" ]] && "${docker_cli}" info >/dev/null 2>&1; then
    return
  fi

  docker_app="$(find_docker_app || true)"
  if [[ -z "${docker_app}" ]]; then
    install_docker_desktop
    docker_app="$(find_docker_app || true)"
  fi
  if [[ -z "${docker_app}" ]]; then
    echo "Docker Desktop was installed but its application could not be found." >&2
    exit 1
  fi

  log "Starting Docker Desktop"
  open "${docker_app}"
  echo "Complete any first-run Docker Desktop prompts. This installer will continue automatically."

  while [[ ${attempt} -lt 300 ]]; do
    docker_cli="$(find_docker_cli || true)"
    if [[ -n "${docker_cli}" ]] && "${docker_cli}" info >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    if (( attempt % 15 == 0 )); then
      echo "[Canvasly] Still waiting for Docker Desktop..."
    fi
    sleep 2
  done

  echo "Docker Desktop did not become ready within 10 minutes." >&2
  echo "Finish the setup shown in Docker Desktop, then run this installer again." >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if is_canvasly_project "${script_dir}"; then
  project_dir="${script_dir}"
  log "Using the Canvasly project at ${project_dir}"
else
  download_canvasly
fi

wait_for_docker
export PATH="$(dirname "${docker_cli}"):${PATH}"

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is unavailable. Update Docker Desktop and run this installer again." >&2
  exit 1
fi

log "Building and starting Canvasly"
if [[ "${copilot_requested}" == "true" ]]; then
  (
    cd "${project_dir}"
    bash ./install.sh --copilot
  )
else
  (
    cd "${project_dir}"
    bash ./install.sh
  )
fi
