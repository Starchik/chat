#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE_FILE="${REPO_DIR}/.env.example"
ENV_FILE="${REPO_DIR}/.env"
CF_OVERRIDE_FILE="${REPO_DIR}/docker-compose.cloudflared.yml"

if [[ ! -f "${REPO_DIR}/docker-compose.yml" ]]; then
  echo "[error] docker-compose.yml not found near script directory."
  echo "Run this script from repository clone (for example: /opt/chat)."
  exit 1
fi

if [[ ! -f "${ENV_EXAMPLE_FILE}" ]]; then
  echo "[error] .env.example not found."
  exit 1
fi

log() {
  printf '\n[setup] %s\n' "$1"
}

warn() {
  printf '\n[warn] %s\n' "$1"
}

fail() {
  printf '\n[error] %s\n' "$1"
  exit 1
}

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local answer

  if [[ -n "${default_value}" ]]; then
    read -r -p "${label} [${default_value}]: " answer
    if [[ -z "${answer}" ]]; then
      answer="${default_value}"
    fi
  else
    read -r -p "${label}: " answer
  fi

  printf '%s' "${answer}"
}

confirm_yes() {
  local label="$1"
  local default_yes="${2:-1}"
  local marker="Y/n"
  local answer=""

  if [[ "${default_yes}" != "1" ]]; then
    marker="y/N"
  fi

  read -r -p "${label} (${marker}): " answer
  answer="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "${answer}" ]]; then
    [[ "${default_yes}" == "1" ]]
    return
  fi

  [[ "${answer}" == "y" || "${answer}" == "yes" ]]
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

get_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return
  fi

  grep -E "^${key}=" "${file}" | tail -n 1 | cut -d '=' -f2-
}

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  local escaped
  escaped="$(printf '%s' "${value}" | sed -e 's/[\\]/\\\\/g' -e 's/[\/&]/\\&/g')"

  if grep -qE "^${key}=" "${file}"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "${file}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

is_placeholder() {
  local value="$1"
  [[ -z "${value}" ]] && return 0
  [[ "${value}" == change-me* ]] && return 0
  [[ "${value}" == "chat.example.com" ]] && return 0
  [[ "${value}" == "admin@example.com" ]] && return 0
  return 1
}

install_docker_stack() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Compose plugin already installed."
    return
  fi

  log "Installing Docker Engine and Compose plugin..."
  as_root apt-get update
  as_root apt-get install -y ca-certificates curl gnupg lsb-release
  as_root install -m 0755 -d /etc/apt/keyrings

  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | as_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    as_root chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local codename
  codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME}")"
  local arch
  arch="$(dpkg --print-architecture)"

  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "${arch}" "${codename}" | as_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  as_root apt-get update
  as_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_cloudflared_if_needed() {
  if command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared already installed."
    return
  fi

  log "Installing cloudflared..."
  as_root mkdir -p --mode=0755 /usr/share/keyrings

  if [[ ! -f /usr/share/keyrings/cloudflare-main.gpg ]]; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | as_root gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
    as_root chmod a+r /usr/share/keyrings/cloudflare-main.gpg
  fi

  printf 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n' | as_root tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  as_root apt-get update
  as_root apt-get install -y cloudflared
}

ubuntu_guard() {
  [[ -f /etc/os-release ]] || fail "Cannot detect OS (missing /etc/os-release)."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "This installer targets Ubuntu only (detected: ${ID:-unknown})."
}

write_cloudflared_override() {
  cat >"${CF_OVERRIDE_FILE}" <<'YAML'
services:
  messenger:
    ports:
      - "127.0.0.1:5000:5000"
YAML
}

log "Interactive installer for Ubuntu server"

ubuntu_guard
require_cmd bash
require_cmd curl
require_cmd sed
require_cmd awk

if [[ "${EUID}" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  fail "sudo is required when script is not started as root."
fi

install_docker_stack

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Creating .env from .env.example"
  cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
else
  if confirm_yes ".env already exists. Re-create from .env.example (old file will be replaced)?" 0; then
    cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    log ".env recreated."
  else
    log "Keeping existing .env and updating selected values only."
  fi
fi

existing_domain="$(get_env_value APP_DOMAIN "${ENV_FILE}")"
if is_placeholder "${existing_domain}"; then
  existing_domain=""
fi

existing_email="$(get_env_value ACME_EMAIL "${ENV_FILE}")"
if is_placeholder "${existing_email}"; then
  existing_email=""
fi

DOMAIN="$(prompt "Public domain for app (for example: chat.example.com)" "${existing_domain}")"
[[ -n "${DOMAIN}" ]] || fail "Domain cannot be empty."

ACME_EMAIL="$(prompt "Email for TLS/ACME notices" "${existing_email:-admin@${DOMAIN}}")"
[[ -n "${ACME_EMAIL}" ]] || fail "Email cannot be empty."

echo
echo "Select deploy mode:"
echo "1) Full public stack (messenger + caddy + coturn)"
echo "2) Cloudflared tunnel (messenger on 127.0.0.1 + optional cloudflared service)"
read -r -p "Choice [1/2]: " MODE_CHOICE
MODE_CHOICE="${MODE_CHOICE:-1}"

if [[ "${MODE_CHOICE}" != "1" && "${MODE_CHOICE}" != "2" ]]; then
  fail "Unknown choice: ${MODE_CHOICE}"
fi

SECRET_KEY="$(get_env_value SECRET_KEY "${ENV_FILE}")"
JWT_SECRET_KEY="$(get_env_value JWT_SECRET_KEY "${ENV_FILE}")"
TURN_CREDENTIAL="$(get_env_value WEBRTC_TURN_CREDENTIAL "${ENV_FILE}")"
POSTGRES_DB_VALUE="$(get_env_value POSTGRES_DB "${ENV_FILE}")"
POSTGRES_USER_VALUE="$(get_env_value POSTGRES_USER "${ENV_FILE}")"
POSTGRES_PASSWORD_VALUE="$(get_env_value POSTGRES_PASSWORD "${ENV_FILE}")"

if is_placeholder "${SECRET_KEY}"; then
  SECRET_KEY="$(random_token)"
fi

if is_placeholder "${JWT_SECRET_KEY}"; then
  JWT_SECRET_KEY="$(random_token)"
fi

if is_placeholder "${TURN_CREDENTIAL}"; then
  TURN_CREDENTIAL="$(random_token)"
fi

if [[ -z "${POSTGRES_DB_VALUE}" ]]; then
  POSTGRES_DB_VALUE="chat"
fi

if [[ -z "${POSTGRES_USER_VALUE}" ]]; then
  POSTGRES_USER_VALUE="chat"
fi

if [[ -z "${POSTGRES_PASSWORD_VALUE}" ]]; then
  POSTGRES_PASSWORD_VALUE="$(random_token)"
fi

if confirm_yes "Use generated random secrets for SECRET_KEY / JWT_SECRET_KEY / WEBRTC_TURN_CREDENTIAL?" 1; then
  :
else
  SECRET_KEY="$(prompt "SECRET_KEY" "${SECRET_KEY}")"
  JWT_SECRET_KEY="$(prompt "JWT_SECRET_KEY" "${JWT_SECRET_KEY}")"
  TURN_CREDENTIAL="$(prompt "WEBRTC_TURN_CREDENTIAL" "${TURN_CREDENTIAL}")"
fi

upsert_env APP_DOMAIN "${DOMAIN}" "${ENV_FILE}"
upsert_env ACME_EMAIL "${ACME_EMAIL}" "${ENV_FILE}"
upsert_env SECRET_KEY "${SECRET_KEY}" "${ENV_FILE}"
upsert_env JWT_SECRET_KEY "${JWT_SECRET_KEY}" "${ENV_FILE}"
upsert_env WEBRTC_TURN_CREDENTIAL "${TURN_CREDENTIAL}" "${ENV_FILE}"
upsert_env TURN_REALM "${DOMAIN}" "${ENV_FILE}"
upsert_env WEBRTC_TURN_URLS "turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp" "${ENV_FILE}"
upsert_env POSTGRES_DB "${POSTGRES_DB_VALUE}" "${ENV_FILE}"
upsert_env POSTGRES_USER "${POSTGRES_USER_VALUE}" "${ENV_FILE}"
upsert_env POSTGRES_PASSWORD "${POSTGRES_PASSWORD_VALUE}" "${ENV_FILE}"
upsert_env DATABASE_URL "postgresql+psycopg://${POSTGRES_USER_VALUE}:${POSTGRES_PASSWORD_VALUE}@postgres:5432/${POSTGRES_DB_VALUE}" "${ENV_FILE}"
upsert_env SOCKETIO_ASYNC_MODE "threading" "${ENV_FILE}"
upsert_env SOCKETIO_FORCE_EVENTLET "0" "${ENV_FILE}"
upsert_env APP_SERVER "gunicorn" "${ENV_FILE}"
upsert_env ATTACHMENT_AUTH_SECURE "1" "${ENV_FILE}"

if [[ "${MODE_CHOICE}" == "1" ]]; then
  rm -f "${CF_OVERRIDE_FILE}"
  log "Starting full public stack..."
  (cd "${REPO_DIR}" && docker compose down && docker compose up -d --build)
else
  write_cloudflared_override
  log "Starting messenger in cloudflared mode..."
  (cd "${REPO_DIR}" && docker compose -f docker-compose.yml -f docker-compose.cloudflared.yml down && docker compose -f docker-compose.yml -f docker-compose.cloudflared.yml up -d --build messenger coturn postgres)

  if confirm_yes "Install/configure cloudflared service now?" 1; then
    install_cloudflared_if_needed
    CF_TOKEN="$(prompt "Paste Cloudflare Tunnel token (starts with ey...)" "")"
    [[ -n "${CF_TOKEN}" ]] || fail "Cloudflare Tunnel token is required."
    as_root cloudflared service install "${CF_TOKEN}"
    as_root systemctl enable --now cloudflared
    as_root systemctl restart cloudflared
    log "cloudflared service installed and restarted."
  else
    warn "cloudflared setup skipped. Configure it manually to proxy ${DOMAIN} -> http://127.0.0.1:5000"
  fi
fi

TARGET_USER="${SUDO_USER:-${USER}}"
if id -nG "${TARGET_USER}" | grep -qw docker; then
  :
else
  warn "User ${TARGET_USER} is not in docker group. Adding now..."
  as_root usermod -aG docker "${TARGET_USER}"
  warn "Re-login is required for docker group to apply to user ${TARGET_USER}."
fi

log "Final checks:"
if [[ "${MODE_CHOICE}" == "1" ]]; then
  (cd "${REPO_DIR}" && docker compose ps)
else
  (cd "${REPO_DIR}" && docker compose -f docker-compose.yml -f docker-compose.cloudflared.yml ps)
fi

if curl -fsS "http://127.0.0.1:5000/health" >/dev/null 2>&1; then
  log "Health endpoint is OK: http://127.0.0.1:5000/health"
else
  warn "Health endpoint check failed. Inspect logs:"
  if [[ "${MODE_CHOICE}" == "1" ]]; then
    echo "  cd ${REPO_DIR} && docker compose logs --tail=120 messenger"
  else
    echo "  cd ${REPO_DIR} && docker compose -f docker-compose.yml -f docker-compose.cloudflared.yml logs --tail=120 messenger"
  fi
fi

if [[ "${MODE_CHOICE}" == "1" ]]; then
  echo
  echo "Open: https://${DOMAIN}"
else
  echo
  echo "Cloudflared mode is active."
  echo "Make sure tunnel ingress points ${DOMAIN} to http://127.0.0.1:5000"
fi

echo
echo "Done."
