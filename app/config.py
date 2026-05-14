import json
import os
from datetime import timedelta
from pathlib import Path


PUBLIC_WEBRTC_STUN_FALLBACK = (
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
)


def _env_bool(name: str, default: bool = False):
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    normalized = raw_value.strip().lower()
    return normalized in {"1", "true", "yes", "y", "on"}


def _split_csv_env(name: str):
    raw_value = os.getenv(name, "")
    if not raw_value:
        return []

    chunks = raw_value.replace(";", ",").split(",")
    return [item.strip() for item in chunks if item and item.strip()]


def _env_float(name: str, default: float):
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    try:
        return float(raw_value.strip())
    except Exception:
        return default


def _normalize_ice_servers(raw_servers):
    normalized_servers = []

    for item in raw_servers:
        if not isinstance(item, dict):
            continue

        urls = item.get("urls")
        if isinstance(urls, str):
            clean_urls = urls.strip()
            if not clean_urls:
                continue
        elif isinstance(urls, list):
            clean_list = [url.strip() for url in urls if isinstance(url, str) and url.strip()]
            if not clean_list:
                continue
            clean_urls = clean_list[0] if len(clean_list) == 1 else clean_list
        else:
            continue

        server = {"urls": clean_urls}

        username = item.get("username")
        credential = item.get("credential")
        if isinstance(username, str) and username.strip():
            server["username"] = username.strip()
        if isinstance(credential, str) and credential.strip():
            server["credential"] = credential.strip()

        normalized_servers.append(server)

    return normalized_servers


def _server_has_url(servers, target_url: str):
    for server in servers:
        urls = server.get("urls")
        if isinstance(urls, str) and urls == target_url:
            return True
        if isinstance(urls, list) and target_url in urls:
            return True
    return False


def _load_webrtc_ice_servers():
    servers = []

    raw_json = os.getenv("WEBRTC_ICE_SERVERS_JSON", "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                servers.extend(_normalize_ice_servers(parsed))
        except Exception:
            # Ignore malformed JSON and continue with plain env vars.
            pass

    for stun_url in _split_csv_env("WEBRTC_STUN_SERVERS"):
        if not _server_has_url(servers, stun_url):
            servers.append({"urls": stun_url})

    turn_urls = _split_csv_env("WEBRTC_TURN_URLS")
    if not turn_urls:
        turn_single = (os.getenv("WEBRTC_TURN_URL") or "").strip()
        if turn_single:
            turn_urls = [turn_single]

    unique_turn_urls = [url for url in turn_urls if not _server_has_url(servers, url)]
    if unique_turn_urls:
        turn_server = {
            "urls": unique_turn_urls[0] if len(unique_turn_urls) == 1 else unique_turn_urls,
        }

        turn_username = (os.getenv("WEBRTC_TURN_USERNAME") or "").strip()
        turn_credential = (os.getenv("WEBRTC_TURN_CREDENTIAL") or "").strip()

        if turn_username:
            turn_server["username"] = turn_username
        if turn_credential:
            turn_server["credential"] = turn_credential

        servers.append(turn_server)

    if _env_bool("WEBRTC_ENABLE_PUBLIC_STUN_FALLBACK", True):
        for fallback_url in PUBLIC_WEBRTC_STUN_FALLBACK:
            if not _server_has_url(servers, fallback_url):
                servers.append({"urls": fallback_url})

    normalized = _normalize_ice_servers(servers)
    if normalized:
        return normalized

    return [{"urls": PUBLIC_WEBRTC_STUN_FALLBACK[0]}]


class Config:
    BASE_DIR = Path(__file__).resolve().parent.parent
    INSTANCE_DIR = BASE_DIR / "instance"

    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-change-me")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-jwt-secret-key-change-me-min-32-bytes")

    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        f"sqlite:///{(INSTANCE_DIR / 'chat.db').as_posix()}",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "connect_args": {"check_same_thread": False}
    }
    TEMPLATES_AUTO_RELOAD = True
    SEND_FILE_MAX_AGE_DEFAULT = 0

    JWT_ACCESS_TOKEN_EXPIRES = timedelta(days=int(os.getenv("JWT_EXPIRES_DAYS", "7")))
    JWT_TOKEN_LOCATION = ["headers"]

    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(20 * 1024 * 1024)))
    UPLOAD_CHUNK_SIZE = int(os.getenv("UPLOAD_CHUNK_SIZE", str(1024 * 1024)))
    MAX_CHUNKED_FILE_SIZE = int(os.getenv("MAX_CHUNKED_FILE_SIZE", str(1024 * 1024 * 1024)))
    CHUNK_UPLOAD_TTL_SEC = int(os.getenv("CHUNK_UPLOAD_TTL_SEC", "7200"))
    IMAGE_PREVIEW_MAX_SIDE = max(256, min(1920, int(os.getenv("IMAGE_PREVIEW_MAX_SIDE", "720"))))
    IMAGE_PREVIEW_WEBP_QUALITY = max(35, min(95, int(os.getenv("IMAGE_PREVIEW_WEBP_QUALITY", "68"))))
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
    ALLOWED_FILE_EXTENSIONS = {
        "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar",
        "7z", "csv", "mp3", "mp4", "avi", "mov", "mkv", "json", "xml", "apk",
    }

    UPLOAD_BASE_FOLDER = BASE_DIR / "app" / "static" / "uploads"
    AVATAR_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "avatars"
    FILE_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "files"
    CHUNK_UPLOAD_FOLDER = INSTANCE_DIR / "chunk_uploads"

    VAPID_PRIVATE_KEY_PATH = os.getenv(
        "VAPID_PRIVATE_KEY_PATH",
        str(INSTANCE_DIR / "vapid_private_key.pem"),
    )
    VAPID_PUBLIC_KEY_PATH = os.getenv(
        "VAPID_PUBLIC_KEY_PATH",
        str(INSTANCE_DIR / "vapid_public_key.txt"),
    )
    VAPID_CLAIMS_SUB = os.getenv("VAPID_CLAIMS_SUB", "mailto:admin@example.com")

    SOCKETIO_ASYNC_MODE = os.getenv("SOCKETIO_ASYNC_MODE", "threading")
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")

    WEBRTC_ICE_SERVERS = _load_webrtc_ice_servers()
    WEBRTC_RING_TIMEOUT_SEC = int(os.getenv("WEBRTC_RING_TIMEOUT_SEC", "45"))
    WEBRTC_RINGTONE_INCOMING_URL = os.getenv(
        "WEBRTC_RINGTONE_INCOMING_URL",
        "/static/sounds/ring-incoming2.wav",
    )
    WEBRTC_RINGTONE_OUTGOING_URL = os.getenv(
        "WEBRTC_RINGTONE_OUTGOING_URL",
        "/static/sounds/ring-outgoing.wav",
    )
    WEBRTC_RINGTONE_INCOMING_VOLUME = max(
        0.0,
        min(1.0, _env_float("WEBRTC_RINGTONE_INCOMING_VOLUME", 0.70)),
    )
    WEBRTC_RINGTONE_OUTGOING_VOLUME = max(
        0.0,
        min(1.0, _env_float("WEBRTC_RINGTONE_OUTGOING_VOLUME", 0.72)),
    )

