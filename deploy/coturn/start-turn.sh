#!/bin/sh
set -eu

TURN_REALM="${TURN_REALM:-${APP_DOMAIN:-chat.local}}"
TURN_LISTEN_PORT="${TURN_LISTEN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"
TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"
TURN_DETECT_EXTERNAL_IP="${TURN_DETECT_EXTERNAL_IP:-0}"
TURN_VERBOSE="${TURN_VERBOSE:-0}"

TURN_USER="${WEBRTC_TURN_USERNAME:-}"
TURN_PASSWORD="${WEBRTC_TURN_CREDENTIAL:-}"

if [ -z "$TURN_USER" ] || [ -z "$TURN_PASSWORD" ]; then
    echo "ERROR: WEBRTC_TURN_USERNAME and WEBRTC_TURN_CREDENTIAL must be set." >&2
    exit 1
fi

detect_external_ip() {
    if command -v curl >/dev/null 2>&1; then
        for url in \
            "https://api64.ipify.org" \
            "https://ifconfig.me/ip" \
            "https://ipv4.icanhazip.com"
        do
            ip="$(curl -fsSL --max-time 5 "$url" 2>/dev/null | tr -d '\r\n\t ' || true)"
            case "$ip" in
                *[!0-9.]* | "") ;;
                *) echo "$ip"; return 0 ;;
            esac
        done
    fi

    if command -v wget >/dev/null 2>&1; then
        for url in \
            "https://api64.ipify.org" \
            "https://ifconfig.me/ip" \
            "https://ipv4.icanhazip.com"
        do
            ip="$(wget -qO- "$url" 2>/dev/null | tr -d '\r\n\t ' || true)"
            case "$ip" in
                *[!0-9.]* | "") ;;
                *) echo "$ip"; return 0 ;;
            esac
        done
    fi

    return 1
}

if [ "$TURN_EXTERNAL_IP" = "auto" ] || [ "$TURN_DETECT_EXTERNAL_IP" = "1" ]; then
    detected_ip="$(detect_external_ip || true)"
    if [ -n "${detected_ip:-}" ]; then
        TURN_EXTERNAL_IP="$detected_ip"
        echo "Detected public IP for TURN: $TURN_EXTERNAL_IP"
    else
        echo "WARN: failed to detect public IP automatically; continuing without --external-ip"
    fi
fi

set -- \
    turnserver \
    -n \
    --no-cli \
    --log-file=stdout \
    --fingerprint \
    --lt-cred-mech \
    --no-multicast-peers \
    --realm="$TURN_REALM" \
    --listening-port="$TURN_LISTEN_PORT" \
    --min-port="$TURN_MIN_PORT" \
    --max-port="$TURN_MAX_PORT" \
    --user="${TURN_USER}:${TURN_PASSWORD}"

if [ -n "$TURN_EXTERNAL_IP" ]; then
    set -- "$@" --external-ip="$TURN_EXTERNAL_IP"
fi

if [ "$TURN_VERBOSE" = "1" ]; then
    set -- "$@" --verbose
fi

exec "$@"
