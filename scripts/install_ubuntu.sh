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

as_target_user() {
  if [[ "${EUID}" -eq 0 && "${TARGET_USER}" != "root" ]]; then
    sudo -u "${TARGET_USER}" -H "$@"
  else
    "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

docker_compose() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
  else
    as_root docker compose "$@"
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

normalize_answer() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

is_yes_answer() {
  local answer="$1"
  case "${answer}" in
    y | yes | 1 | true)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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
  answer="$(normalize_answer "${answer}")"

  if [[ -z "${answer}" ]]; then
    [[ "${default_yes}" == "1" ]]
    return
  fi

  is_yes_answer "${answer}"
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

  grep -E "^${key}=" "${file}" | tail -n 1 | cut -d '=' -f2- || true
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

ensure_valid_port() {
  local port="$1"
  [[ "${port}" =~ ^[0-9]+$ ]] || fail "Port must be a number (got: ${port})."
  ((port >= 1 && port <= 65535)) || fail "Port must be between 1 and 65535 (got: ${port})."
}

is_port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :${port}" 2>/dev/null | tail -n +2 | grep -q .
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {found=1} END {exit(found ? 0 : 1)}'
    return
  fi

  return 1
}

show_port_holders() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    as_root ss -ltnp "sport = :${port}" || true
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    as_root netstat -ltnp 2>/dev/null | grep ":${port}" || true
  fi
}

write_cloudflared_override() {
  local local_port="${1:-5000}"

  cat >"${CF_OVERRIDE_FILE}" <<YAML
services:
  messenger:
    ports:
      - "127.0.0.1:${local_port}:5000"
YAML
}

setup_cloudflared_interactive() {
  local domain="$1"
  local local_port="$2"
  local slug
  local tunnel_name_default
  local tunnel_name
  local tunnel_id
  local target_home
  local config_path
  local credentials_path
  local overwrite_flag=""

  target_home="$(getent passwd "${TARGET_USER}" | cut -d ':' -f6 || true)"
  if [[ -z "${target_home}" ]]; then
    fail "Cannot resolve home directory for user ${TARGET_USER}."
  fi

  slug="$(printf '%s' "${domain}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "${slug}" ]]; then
    slug="tunnel"
  fi

  tunnel_name_default="chat-${slug}"
  tunnel_name="$(prompt "Cloudflare tunnel name" "${tunnel_name_default}")"
  [[ -n "${tunnel_name}" ]] || fail "Tunnel name cannot be empty."
  [[ "${tunnel_name}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "Tunnel name may contain only letters, numbers, dot, dash, underscore."

  log "Cloudflared interactive login..."
  echo "A browser URL will be printed below."
  echo "Open it, authorize domain ${domain}, then return to this terminal."
  as_target_user bash -lc "cloudflared tunnel login"

  log "Creating tunnel ${tunnel_name}..."
  if ! as_target_user bash -lc "cloudflared tunnel create '${tunnel_name}'"; then
    warn "Tunnel create command returned error. Trying to continue with existing tunnel ${tunnel_name}."
  fi

  tunnel_id="$(as_target_user bash -lc "cloudflared tunnel list | awk 'NR>1 && \$2==\"${tunnel_name}\" {print \$1; exit}'")"
  [[ -n "${tunnel_id}" ]] || fail "Cannot find tunnel ID for ${tunnel_name}. Check cloudflared output."

  if confirm_yes "Overwrite existing DNS record for ${domain} if needed?" 1; then
    overwrite_flag="--overwrite-dns"
  fi

  log "Creating DNS route ${domain} -> tunnel ${tunnel_name}..."
  as_target_user bash -lc "cloudflared tunnel route dns ${overwrite_flag} '${tunnel_name}' '${domain}'"

  credentials_path="${target_home}/.cloudflared/${tunnel_id}.json"
  config_path="${target_home}/.cloudflared/config.yml"

  as_target_user mkdir -p "${target_home}/.cloudflared"
  as_target_user bash -lc "cat > '${config_path}' <<EOF
tunnel: ${tunnel_id}
credentials-file: ${credentials_path}
ingress:
  - hostname: ${domain}
    service: http://127.0.0.1:${local_port}
  - service: http_status:404
EOF"

  if as_root test -f /etc/systemd/system/cloudflared.service || as_root test -f /usr/lib/systemd/system/cloudflared.service; then
    if confirm_yes "cloudflared service already exists. Reinstall service using new config?" 1; then
      as_root cloudflared service uninstall || true
    fi
  fi

  as_root cloudflared --config "${config_path}" service install
  as_root systemctl enable --now cloudflared
  as_root systemctl restart cloudflared
  as_root systemctl status cloudflared --no-pager || true

  log "cloudflared interactive tunnel setup is complete."
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

TARGET_USER="${SUDO_USER:-${USER}}"

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

CF_LOCAL_PORT="5000"
if [[ "${MODE_CHOICE}" == "2" ]]; then
  existing_cf_local_port="$(get_env_value CLOUDFLARED_LOCAL_PORT "${ENV_FILE}")"
  if [[ -n "${existing_cf_local_port}" ]]; then
    CF_LOCAL_PORT="${existing_cf_local_port}"
  fi

  CF_LOCAL_PORT="$(prompt "Local host port for messenger in cloudflared mode" "${CF_LOCAL_PORT}")"
  CF_LOCAL_PORT="$(normalize_answer "${CF_LOCAL_PORT}")"
  ensure_valid_port "${CF_LOCAL_PORT}"
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
if [[ "${MODE_CHOICE}" == "2" ]]; then
  upsert_env CLOUDFLARED_LOCAL_PORT "${CF_LOCAL_PORT}" "${ENV_FILE}"
fi

if [[ "${MODE_CHOICE}" == "1" ]]; then
  rm -f "${CF_OVERRIDE_FILE}"
  log "Starting full public stack..."
  (cd "${REPO_DIR}" && docker_compose down && docker_compose up -d --build)
else
  write_cloudflared_override "${CF_LOCAL_PORT}"
  log "Starting messenger in cloudflared mode..."
  (cd "${REPO_DIR}" && docker_compose -f docker-compose.yml -f docker-compose.cloudflared.yml down)

  if is_port_busy "${CF_LOCAL_PORT}"; then
    warn "Local port 127.0.0.1:${CF_LOCAL_PORT} is already in use."
    show_port_holders "${CF_LOCAL_PORT}"
    fail "Free port ${CF_LOCAL_PORT} or rerun installer and choose another local cloudflared port."
  fi

  (cd "${REPO_DIR}" && docker_compose -f docker-compose.yml -f docker-compose.cloudflared.yml up -d --build messenger coturn postgres)

  if confirm_yes "Install/configure cloudflared service now (interactive browser login)?" 1; then
    install_cloudflared_if_needed
    setup_cloudflared_interactive "${DOMAIN}" "${CF_LOCAL_PORT}"
  else
    warn "cloudflared setup skipped. Configure it manually to proxy ${DOMAIN} -> http://127.0.0.1:${CF_LOCAL_PORT}"
  fi
fi

if id -nG "${TARGET_USER}" | grep -qw docker; then
  :
else
  warn "User ${TARGET_USER} is not in docker group. Adding now..."
  as_root usermod -aG docker "${TARGET_USER}"
  warn "Re-login is required for docker group to apply to user ${TARGET_USER}."
fi

log "Final checks:"
if [[ "${MODE_CHOICE}" == "1" ]]; then
  (cd "${REPO_DIR}" && docker_compose ps)
else
  (cd "${REPO_DIR}" && docker_compose -f docker-compose.yml -f docker-compose.cloudflared.yml ps)
fi

HEALTH_PORT="5000"
if [[ "${MODE_CHOICE}" == "2" ]]; then
  HEALTH_PORT="${CF_LOCAL_PORT}"
fi

if curl -fsS "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
  log "Health endpoint is OK: http://127.0.0.1:${HEALTH_PORT}/health"
else
  warn "Health endpoint check failed. Inspect logs:"
  if [[ "${MODE_CHOICE}" == "1" ]]; then
    echo "  cd ${REPO_DIR} && sudo docker compose logs --tail=120 messenger"
  else
    echo "  cd ${REPO_DIR} && sudo docker compose -f docker-compose.yml -f docker-compose.cloudflared.yml logs --tail=120 messenger"
  fi
fi

if [[ "${MODE_CHOICE}" == "1" ]]; then
  echo
  echo "Open: https://${DOMAIN}"
else
  echo
  echo "Cloudflared mode is active."
  echo "Make sure tunnel ingress points ${DOMAIN} to http://127.0.0.1:${CF_LOCAL_PORT}"
fi

echo
echo "Done."
