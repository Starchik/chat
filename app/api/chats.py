from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from app.models import Chat, ChatMembership, Message, User
from app.services import ChatService, MessageService


chats_bp = Blueprint("chats", __name__, url_prefix="/chats")


def serialize_message(message: Message):
    payload = message.to_dict()

    if message.reply_to:
        payload["reply_to"] = {
            "id": message.reply_to.id,
            "sender_id": message.reply_to.sender_id,
            "content": message.reply_to.content,
        }
    else:
        payload["reply_to"] = None

    if message.forwarded_from:
        payload["forwarded_from"] = {
            "id": message.forwarded_from.id,
            "sender_id": message.forwarded_from.sender_id,
            "chat_id": message.forwarded_from.chat_id,
            "sender": message.forwarded_from.sender.to_dict() if message.forwarded_from.sender else None,
            "content": message.forwarded_from.content,
        }
    else:
        payload["forwarded_from"] = None

    return payload


@chats_bp.get("")
@jwt_required()
def list_chats():
    user_id = int(get_jwt_identity())
    include_archived = (request.args.get("archived") or "false").lower() == "true"

    chats = ChatService.list_user_chats(user_id=user_id, include_archived=include_archived)
    result = [ChatService.serialize_chat_for_user(chat, user_id) for chat in chats]

    return jsonify({"chats": result})


@chats_bp.post("")
@jwt_required()
def create_chat():
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}

    chat_type = data.get("type", "private")

    if chat_type == "private":
        target_user_id = data.get("target_user_id")
        if not target_user_id:
            return jsonify({"error": "target_user_id обязателен"}), 400

        chat, error, status = ChatService.create_private_chat(user_id, int(target_user_id))
        if error:
            return jsonify(error), status
        return jsonify({"chat": ChatService.serialize_chat_for_user(chat, user_id)}), 201

    if chat_type == "group":
        title = (data.get("title") or "").strip()
        member_ids = data.get("member_ids") or []
        description = data.get("description")

        if len(title) < 2:
            return jsonify({"error": "Название группы должно быть минимум 2 символа"}), 400

        chat, error, status = ChatService.create_group_chat(
            title=title,
            creator_id=user_id,
            member_ids=member_ids,
            description=description,
        )
        if error:
            return jsonify(error), status
        return jsonify({"chat": ChatService.serialize_chat_for_user(chat, user_id)}), 201

    return jsonify({"error": "Неизвестный тип чата"}), 400


@chats_bp.get("/<int:chat_id>")
@jwt_required()
def get_chat(chat_id: int):
    user_id = int(get_jwt_identity())
    chat = Chat.query.get(chat_id)
    if not chat:
        return jsonify({"error": "Чат не найден"}), 404

    membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
    if not membership:
        return jsonify({"error": "Доступ к чату запрещен"}), 403

    return jsonify({"chat": ChatService.serialize_chat_for_user(chat, user_id)})


@chats_bp.get("/<int:chat_id>/messages")
@jwt_required()
def get_messages(chat_id: int):
    user_id = int(get_jwt_identity())
    membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
    if not membership:
        return jsonify({"error": "Доступ к чату запрещен"}), 403

    limit = min(max(int(request.args.get("limit", 30)), 1), 100)
    before = request.args.get("before")

    query = Message.query.filter_by(chat_id=chat_id).order_by(Message.id.desc())
    if before and before.isdigit():
        query = query.filter(Message.id < int(before))

    chunk = query.limit(limit + 1).all()
    has_more = len(chunk) > limit
    messages = chunk[:limit]
    messages.reverse()

    return jsonify(
        {
            "messages": [serialize_message(message) for message in messages],
            "has_more": has_more,
            "next_before": messages[0].id if messages else None,
        }
    )


@chats_bp.post("/<int:chat_id>/read")
@jwt_required()
def mark_chat_read(chat_id: int):
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    up_to_message_id = data.get("message_id")
    if up_to_message_id is not None and not str(up_to_message_id).isdigit():
        return jsonify({"error": "message_id должен быть числом"}), 400

    payload, error, status = MessageService.mark_read(
        chat_id=chat_id,
        user_id=user_id,
        up_to_message_id=int(up_to_message_id) if up_to_message_id is not None else None,
    )
    if error:
        return jsonify(error), status
    return jsonify(payload)


@chats_bp.patch("/<int:chat_id>/archive")
@jwt_required()
def archive_chat(chat_id: int):
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    archive = bool(data.get("archive", True))

    payload, error = ChatService.archive_chat(chat_id, user_id, archive)
    if error:
        return jsonify(payload), error
    return jsonify(payload)


@chats_bp.get("/<int:chat_id>/members")
@jwt_required()
def get_chat_members(chat_id: int):
    user_id = int(get_jwt_identity())

    membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
    if not membership:
        return jsonify({"error": "Доступ к чату запрещен"}), 403

    members = (
        User.query
        .join(ChatMembership, ChatMembership.user_id == User.id)
        .filter(ChatMembership.chat_id == chat_id)
        .order_by(User.display_name.asc())
        .all()
    )

    return jsonify({"members": [member.to_dict() for member in members]})
