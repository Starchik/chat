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

DEFAULT_POSTGRES_DATABASE_URL = "postgresql+psycopg://chat:chat@postgres:5432/chat"


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


def _env_int(name: str, default: int, *, min_value: int | None = None):
    raw_value = os.getenv(name)
    if raw_value is None:
        value = default
    else:
        try:
            value = int(raw_value.strip())
        except Exception:
            value = default

    if min_value is not None:
        return max(min_value, value)
    return value


def _resolve_database_url() -> str:
    raw_value = (os.getenv("DATABASE_URL") or "").strip()
    database_url = raw_value or DEFAULT_POSTGRES_DATABASE_URL
    normalized = database_url.lower()

    if normalized.startswith("postgres://"):
        # Keep compatibility with legacy URI style.
        database_url = f"postgresql://{database_url[len('postgres://'):]}"

    if not (
        database_url.lower().startswith("postgresql://")
        or database_url.lower().startswith("postgresql+psycopg://")
    ):
        raise RuntimeError(
            "Unsupported DATABASE_URL scheme. "
            "Only PostgreSQL is supported (postgresql:// or postgresql+psycopg://)."
        )

    return database_url


def _build_sqlalchemy_engine_options():
    return {
        "pool_pre_ping": True,
        "pool_size": _env_int("SQLALCHEMY_POOL_SIZE", 20, min_value=1),
        "max_overflow": _env_int("SQLALCHEMY_MAX_OVERFLOW", 40, min_value=0),
        "pool_timeout": _env_int("SQLALCHEMY_POOL_TIMEOUT", 30, min_value=1),
        "pool_recycle": _env_int("SQLALCHEMY_POOL_RECYCLE", 1800, min_value=30),
    }


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

    SQLALCHEMY_DATABASE_URI = _resolve_database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = _build_sqlalchemy_engine_options()
    TEMPLATES_AUTO_RELOAD = True
    SEND_FILE_MAX_AGE_DEFAULT = 0

    JWT_EXPIRES_DAYS = int(os.getenv("JWT_EXPIRES_DAYS", "7"))
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(days=JWT_EXPIRES_DAYS)
    JWT_TOKEN_LOCATION = ["headers"]

    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(20 * 1024 * 1024)))
    UPLOAD_CHUNK_SIZE = int(os.getenv("UPLOAD_CHUNK_SIZE", str(1024 * 1024)))
    MAX_CHUNKED_FILE_SIZE = int(os.getenv("MAX_CHUNKED_FILE_SIZE", str(1024 * 1024 * 1024)))
    CHUNK_UPLOAD_TTL_SEC = int(os.getenv("CHUNK_UPLOAD_TTL_SEC", "7200"))
    CHUNK_CLEANUP_INTERVAL_SEC = _env_int("CHUNK_CLEANUP_INTERVAL_SEC", 600, min_value=60)
    CHUNK_CLEANUP_BACKGROUND = _env_bool("CHUNK_CLEANUP_BACKGROUND", True)
    MESSAGE_RETENTION_ENABLED = _env_bool("MESSAGE_RETENTION_ENABLED", False)
    MESSAGE_RETENTION_DAYS = _env_int("MESSAGE_RETENTION_DAYS", 0, min_value=0)
    MESSAGE_RETENTION_INTERVAL_SEC = _env_int("MESSAGE_RETENTION_INTERVAL_SEC", 3600, min_value=300)
    MESSAGE_RETENTION_BATCH_SIZE = _env_int("MESSAGE_RETENTION_BATCH_SIZE", 500, min_value=10)
    MESSAGE_RETENTION_MAX_BATCHES_PER_RUN = _env_int("MESSAGE_RETENTION_MAX_BATCHES_PER_RUN", 5, min_value=1)
    IMAGE_PREVIEW_MAX_SIDE = max(256, min(1920, int(os.getenv("IMAGE_PREVIEW_MAX_SIDE", "720"))))
    IMAGE_PREVIEW_WEBP_QUALITY = max(35, min(95, int(os.getenv("IMAGE_PREVIEW_WEBP_QUALITY", "68"))))
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
    ALLOWED_FILE_EXTENSIONS = {
        "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar",
        "7z", "csv", "mp3", "wav", "ogg", "opus", "m4a", "aac", "flac",
        "webm", "mp4", "avi", "mov", "mkv", "json", "xml", "apk",
    }

    UPLOAD_BASE_FOLDER = BASE_DIR / "app" / "static" / "uploads"
    AVATAR_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "avatars"
    FILE_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "files"
    LEGACY_FILE_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "files"
    CHUNK_UPLOAD_FOLDER = INSTANCE_DIR / "chunk_uploads"

    ATTACHMENT_AUTH_COOKIE_NAME = os.getenv("ATTACHMENT_AUTH_COOKIE_NAME", "chat_attachment_auth")
    ATTACHMENT_AUTH_COOKIE_PATH = os.getenv("ATTACHMENT_AUTH_COOKIE_PATH", "/api/messages/attachments")
    ATTACHMENT_AUTH_MAX_AGE = int(
        os.getenv(
            "ATTACHMENT_AUTH_MAX_AGE",
            str(JWT_EXPIRES_DAYS * 24 * 60 * 60),
        )
    )
    ATTACHMENT_AUTH_SECURE = _env_bool("ATTACHMENT_AUTH_SECURE", False)
    ATTACHMENT_AUTH_SAMESITE = os.getenv("ATTACHMENT_AUTH_SAMESITE", "Lax")
    ATTACHMENT_AUTH_DOMAIN = (os.getenv("ATTACHMENT_AUTH_DOMAIN") or "").strip() or None
    ATTACHMENT_AUTH_SECRET = os.getenv("ATTACHMENT_AUTH_SECRET", SECRET_KEY)
    ATTACHMENT_AUTH_SALT = os.getenv("ATTACHMENT_AUTH_SALT", "chat-attachment-auth")

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

