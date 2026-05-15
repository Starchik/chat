import json
import math
import os
import errno
import re
import secrets
import shutil
import time

from flask import Blueprint, abort, current_app, jsonify, request, send_file
from flask_jwt_extended import get_jwt_identity, jwt_required, verify_jwt_in_request

from app.extensions import socketio
from app.models import Chat, ChatMembership, Message, MessageAttachment
from app.security.attachment_access import get_attachment_user_id_from_cookie
from app.services import ChatService, MessageService, PushService
from app.services.chunk_upload_service import cleanup_stale_chunk_uploads
from app.utils import (
    generate_image_preview,
    make_storage_filename,
    preview_storage_name,
    sanitize_filename,
)


messages_bp = Blueprint("messages", __name__, url_prefix="/messages")
UPLOAD_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
PREVIEW_SUFFIX = "__preview.webp"
STORED_NAME_PATTERN = re.compile(r"^[a-f0-9]{32}\.[a-z0-9]{1,16}$")


def _attachment_kind_for_name(safe_name: str):
    ext = safe_name.rsplit(".", 1)[1].lower() if "." in safe_name else ""

    if ext in current_app.config["ALLOWED_IMAGE_EXTENSIONS"]:
        return "image"
    if ext in current_app.config["ALLOWED_FILE_EXTENSIONS"]:
        return "file"
    return None


def _resolve_upload_path(stored_name: str):
    primary = current_app.config["FILE_UPLOAD_FOLDER"] / stored_name
    if primary.exists():
        return primary

    legacy_root = current_app.config.get("LEGACY_FILE_UPLOAD_FOLDER")
    if legacy_root:
        legacy = legacy_root / stored_name
        if legacy.exists():
            return legacy

    return None


def _resolve_attachment_user_id() -> int | None:
    cookie_uid = get_attachment_user_id_from_cookie()
    if cookie_uid:
        return cookie_uid

    try:
        verify_jwt_in_request(optional=True)
        identity = get_jwt_identity()
        if identity is None:
            return None
        parsed = int(identity)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def _attachment_error_response(status_code: int, message: str):
    accept = (request.headers.get("Accept") or "").lower()
    fetch_dest = (request.headers.get("Sec-Fetch-Dest") or "").lower()
    wants_html = "text/html" in accept or fetch_dest in {"document", "iframe"}

    if wants_html:
        abort(status_code)

    return jsonify({"error": message}), status_code


def _store_uploaded_files(files):
    attachments = []

    for file in files:
        original_name = file.filename or ""
        if not original_name:
            continue

        safe_name = sanitize_filename(original_name)
        kind = _attachment_kind_for_name(safe_name)
        if not kind:
            return None, {"error": f"Файл '{safe_name}' имеет неподдерживаемый формат"}, 400

        stored_name = make_storage_filename(safe_name)
        file_path = current_app.config["FILE_UPLOAD_FOLDER"] / stored_name

        file.save(file_path)
        if kind == "image":
            _ensure_image_preview(file_path, stored_name)

        file_size = os.path.getsize(file_path)

        attachments.append(
            {
                "file_name": safe_name,
                "stored_name": stored_name,
                "file_url": f"/api/messages/attachments/{stored_name}",
                "mime_type": file.mimetype or "application/octet-stream",
                "file_size": file_size,
                "kind": kind,
            }
        )

    return attachments, None, None


def _preview_stored_name(stored_name: str) -> str:
    return preview_storage_name(stored_name, suffix=PREVIEW_SUFFIX)


def _preview_path(stored_name: str):
    preview_name = _preview_stored_name(stored_name)
    if not preview_name:
        return None
    return current_app.config["FILE_UPLOAD_FOLDER"] / preview_name


def _ensure_image_preview(source_path, stored_name: str):
    preview_path = _preview_path(stored_name)
    if preview_path is None:
        return

    max_side = int(current_app.config.get("IMAGE_PREVIEW_MAX_SIDE", 720))
    quality = int(current_app.config.get("IMAGE_PREVIEW_WEBP_QUALITY", 68))

    generated = generate_image_preview(
        source_path=source_path,
        preview_path=preview_path,
        max_side=max_side,
        quality=quality,
    )
    if not generated:
        current_app.logger.warning("Failed to build image preview for '%s'", stored_name)


def _is_valid_upload_id(upload_id: str) -> bool:
    return bool(upload_id and UPLOAD_ID_PATTERN.fullmatch(upload_id))


def _chunk_meta_path(upload_id: str):
    return current_app.config["CHUNK_UPLOAD_FOLDER"] / f"{upload_id}.json"


def _chunk_part_path(upload_id: str):
    return current_app.config["CHUNK_UPLOAD_FOLDER"] / f"{upload_id}.part"


def _write_chunk_meta(upload_id: str, meta: dict):
    _chunk_meta_path(upload_id).write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def _read_chunk_meta(upload_id: str):
    path = _chunk_meta_path(upload_id)
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _normalize_upload_ids(raw_value):
    if raw_value is None:
        return []

    items = []

    if isinstance(raw_value, list):
        items = raw_value
    elif isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return []

        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    items = parsed
                else:
                    items = [text]
            except Exception:
                items = [text]
        elif "," in text:
            items = text.split(",")
        else:
            items = [text]

    normalized = []
    for item in items:
        if item is None:
            continue
        value = str(item).strip()
        if value:
            normalized.append(value)

    return normalized


def _consume_chunk_uploads(upload_ids, user_id: int, chat_id: int):
    if not upload_ids:
        return [], None, None

    attachments = []
    consumed = set()

    for upload_id in upload_ids:
        if upload_id in consumed:
            continue

        if not _is_valid_upload_id(upload_id):
            return None, {"error": "Некорректный upload_id"}, 400

        meta = _read_chunk_meta(upload_id)
        if not meta:
            return None, {"error": "Загрузка не найдена или уже просрочена"}, 400

        if int(meta.get("user_id", 0)) != user_id:
            return None, {"error": "Эта загрузка принадлежит другому пользователю"}, 403

        if int(meta.get("chat_id", 0)) != chat_id:
            return None, {"error": "Эта загрузка принадлежит другому чату"}, 403

        total_chunks = int(meta.get("total_chunks", 0))
        received_chunks = int(meta.get("received_chunks", 0))
        file_size = int(meta.get("file_size", 0))
        bytes_received = int(meta.get("bytes_received", 0))

        if total_chunks <= 0 or received_chunks < total_chunks or bytes_received != file_size:
            return None, {"error": "Файл еще не загружен полностью"}, 400

        part_path = _chunk_part_path(upload_id)
        if not part_path.exists():
            return None, {"error": "Временный файл загрузки не найден"}, 400

        stored_name = str(meta.get("stored_name") or "").strip()
        file_name = str(meta.get("file_name") or "").strip()
        kind = str(meta.get("kind") or "file")
        mime_type = str(meta.get("mime_type") or "application/octet-stream")

        if not stored_name or not file_name:
            return None, {"error": "Поврежденные метаданные загрузки"}, 400

        final_path = current_app.config["FILE_UPLOAD_FOLDER"] / stored_name
        final_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            try:
                os.replace(part_path, final_path)
            except OSError as replace_error:
                # Cross-device move can fail when temp chunks and final uploads
                # are on different Docker bind mounts.
                if replace_error.errno != errno.EXDEV:
                    raise

                with part_path.open("rb") as src_file, final_path.open("wb") as dst_file:
                    shutil.copyfileobj(src_file, dst_file, length=1024 * 1024)

                try:
                    part_path.unlink()
                except FileNotFoundError:
                    pass
        except Exception:
            return None, {"error": "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043d\u044b\u0439 \u0444\u0430\u0439\u043b"}, 500

        try:
            _chunk_meta_path(upload_id).unlink()
        except FileNotFoundError:
            pass

        if kind == "image":
            _ensure_image_preview(final_path, stored_name)

        final_size = os.path.getsize(final_path)

        attachments.append(
            {
                "file_name": file_name,
                "stored_name": stored_name,
                "file_url": f"/api/messages/attachments/{stored_name}",
                "mime_type": mime_type,
                "file_size": final_size,
                "kind": "image" if kind == "image" else "file",
            }
        )
        consumed.add(upload_id)

    return attachments, None, None


def _broadcast_chat_update(chat_id: int):
    memberships = ChatMembership.query.filter_by(chat_id=chat_id).all()
    for membership in memberships:
        chat = Chat.query.get(chat_id)
        chat_payload = ChatService.serialize_chat_for_user(chat, membership.user_id)
        socketio.emit(
            "chat_updated",
            {"chat": chat_payload},
            room=f"user_{membership.user_id}",
        )


@messages_bp.get("/attachments/<string:stored_name>")
def get_attachment(stored_name: str):
    user_id = _resolve_attachment_user_id()
    if not user_id:
        return _attachment_error_response(401, "Требуется авторизация")

    normalized = (stored_name or "").strip().lower()
    if not STORED_NAME_PATTERN.fullmatch(normalized):
        return _attachment_error_response(404, "Файл не найден")

    attachment = (
        MessageAttachment.query
        .join(Message, Message.id == MessageAttachment.message_id)
        .filter(MessageAttachment.stored_name == normalized)
        .first()
    )
    if not attachment or not attachment.message:
        return _attachment_error_response(404, "Файл не найден")

    membership = ChatMembership.query.filter_by(chat_id=attachment.message.chat_id, user_id=user_id).first()
    if not membership:
        return _attachment_error_response(403, "Доступ к файлу запрещен")

    requested_preview = str(request.args.get("preview") or "").strip().lower() in {"1", "true", "yes", "y", "on"}
    serving_preview = requested_preview and attachment.kind == "image"

    serving_name = attachment.stored_name
    mimetype = attachment.mime_type or "application/octet-stream"
    if serving_preview:
        preview_name = _preview_stored_name(attachment.stored_name)
        preview_path = _resolve_upload_path(preview_name)
        if preview_path is None:
            original_path = _resolve_upload_path(attachment.stored_name)
            if original_path is not None:
                generated = generate_image_preview(
                    source_path=original_path,
                    preview_path=original_path.parent / preview_name,
                    max_side=int(current_app.config.get("IMAGE_PREVIEW_MAX_SIDE", 720)),
                    quality=int(current_app.config.get("IMAGE_PREVIEW_WEBP_QUALITY", 68)),
                )
                if generated:
                    preview_path = _resolve_upload_path(preview_name)

        if preview_path is not None:
            serving_name = preview_name
            mimetype = "image/webp"

    target_path = _resolve_upload_path(serving_name)
    if target_path is None or not target_path.exists():
        return _attachment_error_response(404, "Файл не найден")

    response = send_file(target_path, mimetype=mimetype, conditional=True)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


@messages_bp.post("/uploads/init")
@jwt_required()
def init_chunk_upload():
    user_id = int(get_jwt_identity())
    payload = request.get_json(silent=True) or {}

    chat_id_raw = payload.get("chat_id")
    file_name_raw = payload.get("file_name")
    file_size_raw = payload.get("file_size")
    mime_type = str(payload.get("mime_type") or "application/octet-stream").strip() or "application/octet-stream"

    if not chat_id_raw or not str(chat_id_raw).isdigit():
        return jsonify({"error": "chat_id обязателен"}), 400

    chat_id = int(chat_id_raw)
    membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
    if not membership:
        return jsonify({"error": "Доступ к чату запрещен"}), 403

    safe_name = sanitize_filename(str(file_name_raw or ""))
    if not safe_name:
        return jsonify({"error": "Имя файла обязательно"}), 400

    kind = _attachment_kind_for_name(safe_name)
    if not kind:
        return jsonify({"error": f"Файл '{safe_name}' имеет неподдерживаемый формат"}), 400

    try:
        file_size = int(file_size_raw)
    except Exception:
        return jsonify({"error": "Некорректный file_size"}), 400

    if file_size <= 0:
        return jsonify({"error": "Размер файла должен быть больше 0"}), 400

    max_chunked_file_size = int(current_app.config.get("MAX_CHUNKED_FILE_SIZE", 1024 * 1024 * 1024))
    if max_chunked_file_size > 0 and file_size > max_chunked_file_size:
        max_mb = round(max_chunked_file_size / (1024 * 1024), 2)
        return jsonify({"error": f"Файл слишком большой (лимит: {max_mb} MB)"}), 413

    cleanup_stale_chunk_uploads()

    requested_chunk_size = int(current_app.config.get("UPLOAD_CHUNK_SIZE", 1024 * 1024))
    max_request_size = int(current_app.config.get("MAX_CONTENT_LENGTH") or 0)

    effective_chunk_size = max(64 * 1024, requested_chunk_size)
    if max_request_size > 0:
        # Keep chunk safely lower than the Flask request-size limit.
        effective_chunk_size = min(effective_chunk_size, max(64 * 1024, max_request_size - 256 * 1024))

    total_chunks = max(1, math.ceil(file_size / effective_chunk_size))
    upload_id = secrets.token_hex(16)
    stored_name = make_storage_filename(safe_name)
    now = int(time.time())

    meta = {
        "upload_id": upload_id,
        "user_id": user_id,
        "chat_id": chat_id,
        "file_name": safe_name,
        "stored_name": stored_name,
        "file_size": file_size,
        "mime_type": mime_type,
        "kind": kind,
        "chunk_size": effective_chunk_size,
        "total_chunks": total_chunks,
        "received_chunks": 0,
        "bytes_received": 0,
        "created_at": now,
        "updated_at": now,
    }

    _write_chunk_meta(upload_id, meta)
    _chunk_part_path(upload_id).write_bytes(b"")

    return jsonify(
        {
            "upload_id": upload_id,
            "chunk_size": effective_chunk_size,
            "total_chunks": total_chunks,
            "file_size": file_size,
            "file_name": safe_name,
        }
    )


@messages_bp.post("/uploads/chunk")
@jwt_required()
def upload_chunk():
    user_id = int(get_jwt_identity())

    upload_id = str(request.form.get("upload_id") or "").strip()
    chunk_index_raw = request.form.get("chunk_index")
    chunk_file = request.files.get("chunk")

    if not _is_valid_upload_id(upload_id):
        return jsonify({"error": "Некорректный upload_id"}), 400

    if chunk_index_raw is None or not str(chunk_index_raw).isdigit():
        return jsonify({"error": "chunk_index обязателен"}), 400

    chunk_index = int(chunk_index_raw)
    if chunk_index < 0:
        return jsonify({"error": "Некорректный chunk_index"}), 400

    if chunk_file is None:
        return jsonify({"error": "Чанк не передан"}), 400

    meta = _read_chunk_meta(upload_id)
    if not meta:
        return jsonify({"error": "Загрузка не найдена или уже просрочена"}), 404

    if int(meta.get("user_id", 0)) != user_id:
        return jsonify({"error": "Эта загрузка принадлежит другому пользователю"}), 403

    total_chunks = int(meta.get("total_chunks", 0))
    received_chunks = int(meta.get("received_chunks", 0))
    bytes_received = int(meta.get("bytes_received", 0))
    file_size = int(meta.get("file_size", 0))
    chunk_size_limit = int(meta.get("chunk_size", 0))

    if chunk_index >= total_chunks:
        return jsonify({"error": "chunk_index вне диапазона"}), 400

    if chunk_index != received_chunks:
        return jsonify({"error": "Неверный порядок чанков"}), 409

    chunk_bytes = chunk_file.read() or b""
    chunk_size = len(chunk_bytes)
    if chunk_size <= 0:
        return jsonify({"error": "Пустой чанк не допускается"}), 400

    if chunk_size_limit > 0 and chunk_size > chunk_size_limit:
        return jsonify({"error": "Размер чанка превышает лимит"}), 413

    remaining = file_size - bytes_received
    if remaining <= 0:
        return jsonify({"error": "Загрузка уже завершена"}), 400

    if chunk_size > remaining:
        return jsonify({"error": "Размер чанка больше ожидаемого"}), 400

    with _chunk_part_path(upload_id).open("ab") as part_file:
        part_file.write(chunk_bytes)

    meta["received_chunks"] = received_chunks + 1
    meta["bytes_received"] = bytes_received + chunk_size
    meta["updated_at"] = int(time.time())
    _write_chunk_meta(upload_id, meta)

    completed = int(meta["bytes_received"]) == int(meta["file_size"]) and int(meta["received_chunks"]) == int(meta["total_chunks"])

    return jsonify(
        {
            "upload_id": upload_id,
            "received_chunks": int(meta["received_chunks"]),
            "total_chunks": int(meta["total_chunks"]),
            "bytes_received": int(meta["bytes_received"]),
            "file_size": int(meta["file_size"]),
            "completed": completed,
        }
    )


@messages_bp.post("")
@jwt_required()
def send_message():
    user_id = int(get_jwt_identity())

    if request.content_type and "multipart/form-data" in request.content_type:
        chat_id = request.form.get("chat_id")
        content = request.form.get("content")
        reply_to_id = request.form.get("reply_to_id")
        forwarded_from_message_id = request.form.get("forwarded_from_message_id")
        files = request.files.getlist("files")
        upload_ids = _normalize_upload_ids(request.form.getlist("upload_ids"))
    else:
        payload = request.get_json(silent=True) or {}
        chat_id = payload.get("chat_id")
        content = payload.get("content")
        reply_to_id = payload.get("reply_to_id")
        forwarded_from_message_id = payload.get("forwarded_from_message_id")
        files = []
        upload_ids = _normalize_upload_ids(payload.get("upload_ids"))

    if not chat_id or not str(chat_id).isdigit():
        return jsonify({"error": "chat_id обязателен"}), 400

    chat_id_int = int(chat_id)
    membership = ChatMembership.query.filter_by(chat_id=chat_id_int, user_id=user_id).first()
    if not membership:
        return jsonify({"error": "Доступ к чату запрещен"}), 403

    direct_attachments, error, status = _store_uploaded_files(files)
    if error:
        return jsonify(error), status

    chunk_attachments, error, status = _consume_chunk_uploads(upload_ids, user_id=user_id, chat_id=chat_id_int)
    if error:
        return jsonify(error), status

    attachments_payload = (direct_attachments or []) + (chunk_attachments or [])

    message, error, status = MessageService.create_message(
        chat_id=chat_id_int,
        sender_id=user_id,
        content=content,
        reply_to_id=int(reply_to_id) if reply_to_id and str(reply_to_id).isdigit() else None,
        forwarded_from_message_id=(
            int(forwarded_from_message_id)
            if forwarded_from_message_id and str(forwarded_from_message_id).isdigit()
            else None
        ),
        attachments_payload=attachments_payload,
    )

    if error:
        return jsonify(error), status

    message_payload = message.to_dict()
    socketio.emit("new_message", {"message": message_payload}, room=f"chat_{message.chat_id}")

    chat = Chat.query.get(message.chat_id)
    sender = message.sender.display_name if message.sender else "Пользователь"
    preview = message.content or "Вложение"

    PushService.notify_chat_members(
        current_app,
        chat_id=message.chat_id,
        sender_id=user_id,
        payload={
            "title": chat.title or sender,
            "body": f"{sender}: {preview[:80]}",
            "chat_id": message.chat_id,
        },
    )

    _broadcast_chat_update(message.chat_id)

    return jsonify({"message": message_payload}), 201


@messages_bp.put("/<int:message_id>")
@jwt_required()
def edit_message(message_id: int):
    user_id = int(get_jwt_identity())
    payload = request.get_json(silent=True) or {}
    new_content = payload.get("content") or ""

    message, error, status = MessageService.edit_message(message_id, user_id, new_content)
    if error:
        return jsonify(error), status

    response = {"message": message.to_dict()}
    socketio.emit("message_updated", response, room=f"chat_{message.chat_id}")
    _broadcast_chat_update(message.chat_id)
    return jsonify(response)


@messages_bp.delete("/<int:message_id>")
@jwt_required()
def delete_message(message_id: int):
    user_id = int(get_jwt_identity())

    message = Message.query.get(message_id)
    chat_id = message.chat_id if message else None

    payload, error = MessageService.delete_message(message_id, user_id)
    if error:
        return jsonify(payload), error

    socketio.emit("message_deleted", payload, room=f"chat_{chat_id}")
    _broadcast_chat_update(chat_id)
    return jsonify(payload)


@messages_bp.post("/<int:message_id>/forward")
@jwt_required()
def forward_message(message_id: int):
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    target_chat_id = data.get("target_chat_id")

    if not target_chat_id or not str(target_chat_id).isdigit():
        return jsonify({"error": "target_chat_id обязателен"}), 400

    message, error, status = MessageService.forward_message(
        source_message_id=message_id,
        user_id=user_id,
        target_chat_id=int(target_chat_id),
    )
    if error:
        return jsonify(error), status

    payload = {"message": message.to_dict()}
    socketio.emit("new_message", payload, room=f"chat_{message.chat_id}")
    _broadcast_chat_update(message.chat_id)

    return jsonify(payload), 201


@messages_bp.post("/<int:message_id>/pin")
@jwt_required()
def pin_message(message_id: int):
    user_id = int(get_jwt_identity())

    pin, error, status = MessageService.pin_message(message_id, user_id)
    if error:
        return jsonify(error), status

    message = Message.query.get(message_id)
    payload = {
        "pin": pin.to_dict(),
        "message": message.to_dict(),
    }
    socketio.emit("message_pinned", payload, room=f"chat_{message.chat_id}")
    _broadcast_chat_update(message.chat_id)

    return jsonify(payload), 201


@messages_bp.delete("/<int:message_id>/pin")
@jwt_required()
def unpin_message(message_id: int):
    user_id = int(get_jwt_identity())

    message = Message.query.get(message_id)
    if not message:
        return jsonify({"error": "Сообщение не найдено"}), 404

    payload, error = MessageService.unpin_message(message_id, user_id)
    if error:
        return jsonify(payload), error

    socketio.emit("message_unpinned", payload, room=f"chat_{message.chat_id}")
    _broadcast_chat_update(message.chat_id)
    return jsonify(payload)
