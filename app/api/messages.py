import os

from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from app.extensions import socketio
from app.models import Chat, ChatMembership, Message
from app.services import ChatService, MessageService, PushService
from app.utils import (
    make_storage_filename,
    sanitize_filename,
)


messages_bp = Blueprint("messages", __name__, url_prefix="/messages")


def _store_uploaded_files(files):
    attachments = []

    for file in files:
        original_name = file.filename or ""
        if not original_name:
            continue

        safe_name = sanitize_filename(original_name)
        ext = safe_name.rsplit(".", 1)[1].lower() if "." in safe_name else ""

        is_image = ext in current_app.config["ALLOWED_IMAGE_EXTENSIONS"]
        is_file = ext in current_app.config["ALLOWED_FILE_EXTENSIONS"]

        if not is_image and not is_file:
            return None, {"error": f"Файл '{safe_name}' имеет неподдерживаемый формат"}, 400

        stored_name = make_storage_filename(safe_name)
        file_path = current_app.config["FILE_UPLOAD_FOLDER"] / stored_name

        file.save(file_path)
        file_size = os.path.getsize(file_path)

        attachments.append(
            {
                "file_name": safe_name,
                "stored_name": stored_name,
                "file_url": f"/static/uploads/files/{stored_name}",
                "mime_type": file.mimetype or "application/octet-stream",
                "file_size": file_size,
                "kind": "image" if is_image else "file",
            }
        )

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
    else:
        payload = request.get_json(silent=True) or {}
        chat_id = payload.get("chat_id")
        content = payload.get("content")
        reply_to_id = payload.get("reply_to_id")
        forwarded_from_message_id = payload.get("forwarded_from_message_id")
        files = []

    if not chat_id or not str(chat_id).isdigit():
        return jsonify({"error": "chat_id обязателен"}), 400

    attachments_payload, error, status = _store_uploaded_files(files)
    if error:
        return jsonify(error), status

    message, error, status = MessageService.create_message(
        chat_id=int(chat_id),
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

