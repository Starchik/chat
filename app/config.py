import os
from datetime import timedelta
from pathlib import Path


class Config:
    BASE_DIR = Path(__file__).resolve().parent.parent
    INSTANCE_DIR = BASE_DIR / "instance"

    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-change-me")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-jwt-secret-change-me")

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
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
    ALLOWED_FILE_EXTENSIONS = {
        "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar",
        "7z", "csv", "mp3", "mp4", "avi", "mov", "mkv", "json", "xml", "apk",
    }

    UPLOAD_BASE_FOLDER = BASE_DIR / "app" / "static" / "uploads"
    AVATAR_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "avatars"
    FILE_UPLOAD_FOLDER = UPLOAD_BASE_FOLDER / "files"

    VAPID_PRIVATE_KEY_PATH = os.getenv(
        "VAPID_PRIVATE_KEY_PATH",
        str(INSTANCE_DIR / "vapid_private_key.pem"),
    )
    VAPID_PUBLIC_KEY_PATH = os.getenv(
        "VAPID_PUBLIC_KEY_PATH",
        str(INSTANCE_DIR / "vapid_public_key.txt"),
    )
    VAPID_CLAIMS_SUB = os.getenv("VAPID_CLAIMS_SUB", "mailto:admin@example.com")

    SOCKETIO_ASYNC_MODE = os.getenv("SOCKETIO_ASYNC_MODE", "eventlet")
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
