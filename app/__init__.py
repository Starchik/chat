import os
import threading
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, url_for
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from app.api import register_api
from app.config import Config
from app.extensions import db, init_extensions
from app.services.chunk_upload_service import cleanup_stale_chunk_uploads
from app.services.message_retention_service import cleanup_expired_messages
from app.sockets import register_sockets
from app.utils import b64url_encode, ensure_directories

_chunk_cleanup_worker_started = False
_chunk_cleanup_worker_lock = threading.Lock()
_message_retention_worker_started = False
_message_retention_worker_lock = threading.Lock()


def _ensure_vapid_keys(app):
    private_key_path = Path(app.config["VAPID_PRIVATE_KEY_PATH"])
    public_key_path = Path(app.config["VAPID_PUBLIC_KEY_PATH"])

    if private_key_path.exists() and public_key_path.exists():
        app.config["VAPID_PUBLIC_KEY"] = public_key_path.read_text(encoding="utf-8").strip()
        return

    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    public_key_path.parent.mkdir(parents=True, exist_ok=True)

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key().public_numbers()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    private_key_path.write_bytes(private_pem)

    public_key_bytes = b"\x04" + public_key.x.to_bytes(32, "big") + public_key.y.to_bytes(32, "big")
    public_key_b64 = b64url_encode(public_key_bytes)
    public_key_path.write_text(public_key_b64, encoding="utf-8")

    app.config["VAPID_PUBLIC_KEY"] = public_key_b64


def _start_chunk_cleanup_worker(app):
    global _chunk_cleanup_worker_started

    if not app.config.get("CHUNK_CLEANUP_BACKGROUND", True):
        return

    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    with _chunk_cleanup_worker_lock:
        if _chunk_cleanup_worker_started:
            return
        _chunk_cleanup_worker_started = True

    interval_sec = max(60, int(app.config.get("CHUNK_CLEANUP_INTERVAL_SEC", 600)))

    def _worker():
        while True:
            try:
                with app.app_context():
                    removed = cleanup_stale_chunk_uploads(app=app)
                    if removed > 0:
                        app.logger.info("Chunk cleanup removed %s stale file(s)", removed)
            except Exception:
                app.logger.exception("Chunk cleanup worker failed")

            time.sleep(interval_sec)

    thread = threading.Thread(
        target=_worker,
        name="chunk-cleanup-worker",
        daemon=True,
    )
    thread.start()


def _start_message_retention_worker(app):
    global _message_retention_worker_started

    if not app.config.get("MESSAGE_RETENTION_ENABLED", False):
        return

    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    with _message_retention_worker_lock:
        if _message_retention_worker_started:
            return
        _message_retention_worker_started = True

    interval_sec = max(300, int(app.config.get("MESSAGE_RETENTION_INTERVAL_SEC", 3600)))

    def _worker():
        while True:
            try:
                with app.app_context():
                    result = cleanup_expired_messages(app=app)
                    if result.get("deleted_messages", 0) > 0 or result.get("deleted_files", 0) > 0:
                        app.logger.info(
                            "Message retention removed %s message(s), %s file(s) across %s chat(s)",
                            result.get("deleted_messages", 0),
                            result.get("deleted_files", 0),
                            result.get("affected_chats", 0),
                        )
            except Exception:
                app.logger.exception("Message retention worker failed")

            time.sleep(interval_sec)

    thread = threading.Thread(
        target=_worker,
        name="message-retention-worker",
        daemon=True,
    )
    thread.start()


def create_app():
    load_dotenv()

    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)

    ensure_directories(
        [
            app.config["INSTANCE_DIR"],
            app.config["UPLOAD_BASE_FOLDER"],
            app.config["AVATAR_UPLOAD_FOLDER"],
            app.config["FILE_UPLOAD_FOLDER"],
            app.config["CHUNK_UPLOAD_FOLDER"],
        ]
    )

    _ensure_vapid_keys(app)
    init_extensions(app)
    register_api(app)
    register_sockets()

    with app.app_context():
        db.create_all()
        try:
            removed = cleanup_stale_chunk_uploads(app=app)
            if removed > 0:
                app.logger.info("Chunk cleanup removed %s stale file(s) on startup", removed)
        except Exception:
            app.logger.exception("Chunk cleanup on startup failed")
        try:
            result = cleanup_expired_messages(app=app)
            if result.get("deleted_messages", 0) > 0 or result.get("deleted_files", 0) > 0:
                app.logger.info(
                    "Message retention removed %s message(s), %s file(s) across %s chat(s) on startup",
                    result.get("deleted_messages", 0),
                    result.get("deleted_files", 0),
                    result.get("affected_chats", 0),
                )
        except Exception:
            app.logger.exception("Message retention on startup failed")

    _start_chunk_cleanup_worker(app)
    _start_message_retention_worker(app)

    def asset_url(filename: str) -> str:
        static_root = Path(app.static_folder or "")
        try:
            version = int((static_root / filename).stat().st_mtime)
        except OSError:
            version = 0
        return url_for("static", filename=filename, v=version)

    app.jinja_env.globals["asset_url"] = asset_url

    @app.context_processor
    def inject_runtime_config():
        return {
                "runtime_config": {
                    "webrtc_ice_servers": app.config.get("WEBRTC_ICE_SERVERS", []),
                    "webrtc_ring_timeout_sec": int(app.config.get("WEBRTC_RING_TIMEOUT_SEC", 90)),
                    "webrtc_ringtone_incoming_url": app.config.get("WEBRTC_RINGTONE_INCOMING_URL", ""),
                "webrtc_ringtone_outgoing_url": app.config.get("WEBRTC_RINGTONE_OUTGOING_URL", ""),
                "webrtc_ringtone_incoming_volume": float(app.config.get("WEBRTC_RINGTONE_INCOMING_VOLUME", 0.88)),
                "webrtc_ringtone_outgoing_volume": float(app.config.get("WEBRTC_RINGTONE_OUTGOING_VOLUME", 0.72)),
                "upload_chunk_size": int(app.config.get("UPLOAD_CHUNK_SIZE", 1024 * 1024)),
            }
        }

    @app.get("/")
    def index():
        return render_template("chat.html")

    @app.get("/login")
    def login_page():
        return render_template("login.html")

    @app.get("/register")
    def register_page():
        return render_template("register.html")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    error_page_meta = {
        401: {
            "title": "Требуется авторизация",
            "message": "Для доступа к этой странице нужно войти в аккаунт.",
            "hint": "Проверьте, что вы авторизованы, и попробуйте открыть страницу снова.",
            "label": "Нужен вход",
            "icon": "fa-solid fa-user-lock",
            "variant": "auth",
        },
        403: {
            "title": "Доступ запрещен",
            "message": "У вас нет прав для просмотра этой страницы или ресурса.",
            "hint": "Если это ошибка, обратитесь к администратору или владельцу чата.",
            "label": "Нет доступа",
            "icon": "fa-solid fa-shield-halved",
            "variant": "forbidden",
        },
        404: {
            "title": "Страница не найдена",
            "message": "Запрошенный адрес не существует или уже был удален.",
            "hint": "Проверьте ссылку или перейдите на главную страницу.",
            "label": "Не найдено",
            "icon": "fa-solid fa-magnifying-glass",
            "variant": "missing",
        },
        413: {
            "title": "Файл слишком большой",
            "message": "Размер запроса превышает допустимый лимит сервера.",
            "hint": "Для больших файлов используйте загрузку частями.",
            "label": "Слишком большой файл",
            "icon": "fa-solid fa-file-circle-xmark",
            "variant": "payload",
        },
        500: {
            "title": "Ошибка сервера",
            "message": "На сервере произошла внутренняя ошибка.",
            "hint": "Попробуйте обновить страницу немного позже.",
            "label": "Ошибка сервера",
            "icon": "fa-solid fa-triangle-exclamation",
            "variant": "server",
        },
    }

    def _is_api_request() -> bool:
        path = (request.path or "").lower()
        accept = (request.headers.get("Accept") or "").lower()
        fetch_dest = (request.headers.get("Sec-Fetch-Dest") or "").lower()
        wants_html = "text/html" in accept or fetch_dest in {"document", "iframe"}

        # Allow pretty HTML error pages for direct browser opens of protected attachments.
        if path.startswith("/api/messages/attachments/") and wants_html:
            return False

        if path.startswith("/api/"):
            return True

        return "application/json" in accept and "text/html" not in accept

    def _render_error_page(status_code: int, message_override: str | None = None):
        meta = error_page_meta.get(status_code)
        if not meta:
            meta = {
                "title": f"Ошибка {status_code}",
                "message": "Произошла ошибка при обработке запроса.",
                "hint": "Проверьте адрес страницы или попробуйте выполнить действие позже.",
                "label": "Ошибка",
                "icon": "fa-solid fa-circle-exclamation",
                "variant": "generic",
            }
        return (
            render_template(
                "error.html",
                status_code=status_code,
                title=meta["title"],
                message=message_override or meta["message"],
                hint=meta["hint"],
                label=meta["label"],
                icon=meta["icon"],
                variant=meta["variant"],
            ),
            status_code,
        )

    @app.after_request
    def add_cache_headers(response):
        path = request.path or ""

        if response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        if path == "/static/sw.js":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        return response

    @app.before_request
    def block_public_uploaded_files():
        path = request.path or ""
        if path.startswith("/static/uploads/files/"):
            return "", 404

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_entity_too_large(_error):
        max_length = int(app.config.get("MAX_CONTENT_LENGTH", 0))
        max_mb = round(max_length / (1024 * 1024), 2) if max_length > 0 else 0
        message = (
            f"Файл слишком большой для одного запроса (лимит: {max_mb} MB). "
            "Повторите отправку через загрузку частями."
        )

        if _is_api_request():
            return jsonify({"error": message}), 413

        return _render_error_page(413, message_override=message)

    @app.errorhandler(HTTPException)
    def handle_http_exception(error: HTTPException):
        status_code = int(error.code or 500)

        if _is_api_request():
            default_message = error_page_meta.get(status_code, error_page_meta[500])["message"]
            return jsonify({"error": default_message}), status_code

        return _render_error_page(status_code)

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        app.logger.exception("Unhandled server error", exc_info=error)

        if _is_api_request():
            return jsonify({"error": error_page_meta[500]["message"]}), 500

        return _render_error_page(500)

    return app
