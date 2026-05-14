import base64
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from werkzeug.utils import secure_filename

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except Exception:  # pragma: no cover - optional dependency in some environments
    Image = None
    ImageOps = None
    UnidentifiedImageError = Exception


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


def preview_storage_name(stored_name: str, suffix: str = "__preview.webp") -> str:
    clean_name = (stored_name or "").strip()
    if not clean_name:
        return ""

    stem = clean_name.rsplit(".", 1)[0] if "." in clean_name else clean_name
    return f"{stem}{suffix}"


def generate_image_preview(source_path, preview_path, max_side: int = 720, quality: int = 68) -> bool:
    if Image is None or ImageOps is None:
        return False

    source = Path(source_path)
    destination = Path(preview_path)
    if not source.exists():
        return False

    max_side = max(256, min(1920, int(max_side)))
    quality = max(35, min(95, int(quality)))
    destination.parent.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)

            if "A" in image.getbands():
                if image.mode != "RGBA":
                    image = image.convert("RGBA")
            elif image.mode != "RGB":
                image = image.convert("RGB")

            resampling = getattr(Image, "Resampling", Image).LANCZOS
            image.thumbnail((max_side, max_side), resample=resampling)
            image.save(
                destination,
                format="WEBP",
                quality=quality,
                method=6,
                optimize=True,
            )
        return True
    except (FileNotFoundError, UnidentifiedImageError, OSError, ValueError):
        try:
            if destination.exists():
                destination.unlink()
        except Exception:
            pass
        return False
