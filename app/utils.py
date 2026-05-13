import base64
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from werkzeug.utils import secure_filename


def utcnow():
    return datetime.now(timezone.utc)


def ensure_directories(paths):
    for path in paths:
        Path(path).mkdir(parents=True, exist_ok=True)


def extension_of(filename):
    return filename.rsplit(".", 1)[1].lower() if "." in filename else ""


def is_allowed_file(filename, allowed_extensions):
    ext = extension_of(filename)
    return bool(ext) and ext in allowed_extensions


def make_storage_filename(filename):
    ext = extension_of(filename)
    token = secrets.token_hex(16)
    if not ext:
        return token
    return f"{token}.{ext}"


def sanitize_filename(filename):
    safe = secure_filename(filename)
    return safe or "file"


def isoformat_or_none(value):
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("utf-8")


def b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def absolute_upload_path(base_folder, stored_name):
    return os.path.join(base_folder, stored_name)
