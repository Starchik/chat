from collections import defaultdict

from flask import request
from flask_jwt_extended import decode_token
from flask_socketio import ConnectionRefusedError, emit, join_room, leave_room

from app.extensions import db, socketio
from app.models import ChatMembership, User
from app.services import MessageService


sid_to_user: dict[str, int] = {}
user_to_sids: dict[int, set[str]] = defaultdict(set)


def _extract_token(auth_payload):
    if auth_payload and isinstance(auth_payload, dict):
        token = auth_payload.get("token")
        if token:
            return token

    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()

    return request.args.get("token")


def _broadcast_user_status(user_id: int, is_online: bool):
    memberships = ChatMembership.query.filter_by(user_id=user_id).all()
    affected_chat_ids = {membership.chat_id for membership in memberships}

    payload = {
        "user_id": user_id,
        "is_online": is_online,
    }

    for chat_id in affected_chat_ids:
        socketio.emit("user_status", payload, room=f"chat_{chat_id}")


@socketio.on("connect")
def socket_connect(auth):
    token = _extract_token(auth)
    if not token:
        raise ConnectionRefusedError("Требуется токен")

    try:
        decoded = decode_token(token)
    except Exception as exc:
        raise ConnectionRefusedError("Недействительный токен") from exc

    identity = decoded.get("sub")
    if identity is None:
        raise ConnectionRefusedError("Недействительный токен")

    user_id = int(identity)
    user = User.query.get(user_id)
    if not user:
        raise ConnectionRefusedError("Пользователь не найден")

    sid_to_user[request.sid] = user_id
    user_to_sids[user_id].add(request.sid)

    user.mark_online()
    db.session.commit()

    join_room(f"user_{user_id}")

    memberships = ChatMembership.query.filter_by(user_id=user_id).all()
    for membership in memberships:
        join_room(f"chat_{membership.chat_id}")

    _broadcast_user_status(user_id, True)

    emit("connected", {"user_id": user_id})


@socketio.on("disconnect")
def socket_disconnect():
    sid = request.sid
    user_id = sid_to_user.pop(sid, None)
    if not user_id:
        return

    sids = user_to_sids.get(user_id)
    if sids and sid in sids:
        sids.remove(sid)

    if sids:
        return

    user_to_sids.pop(user_id, None)

    user = User.query.get(user_id)
    if user:
        user.mark_offline()
        db.session.commit()

    _broadcast_user_status(user_id, False)


@socketio.on("join_chat")
def socket_join_chat(data):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        emit("error", {"error": "Не авторизован"})
        return

    chat_id = data.get("chat_id") if isinstance(data, dict) else None
    if not chat_id or not str(chat_id).isdigit():
        emit("error", {"error": "chat_id обязателен"})
        return

    membership = ChatMembership.query.filter_by(chat_id=int(chat_id), user_id=user_id).first()
    if not membership:
        emit("error", {"error": "Доступ к чату запрещен"})
        return

    join_room(f"chat_{chat_id}")
    emit("joined_chat", {"chat_id": int(chat_id)})


@socketio.on("leave_chat")
def socket_leave_chat(data):
    chat_id = data.get("chat_id") if isinstance(data, dict) else None
    if not chat_id or not str(chat_id).isdigit():
        emit("error", {"error": "chat_id обязателен"})
        return

    leave_room(f"chat_{chat_id}")
    emit("left_chat", {"chat_id": int(chat_id)})


@socketio.on("typing")
def socket_typing(data):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        emit("error", {"error": "Не авторизован"})
        return

    chat_id = data.get("chat_id") if isinstance(data, dict) else None
    is_typing = bool(data.get("is_typing", True)) if isinstance(data, dict) else True

    if not chat_id or not str(chat_id).isdigit():
        emit("error", {"error": "chat_id обязателен"})
        return

    membership = ChatMembership.query.filter_by(chat_id=int(chat_id), user_id=user_id).first()
    if not membership:
        emit("error", {"error": "Доступ к чату запрещен"})
        return

    emit(
        "typing",
        {
            "chat_id": int(chat_id),
            "user_id": user_id,
            "is_typing": is_typing,
        },
        room=f"chat_{chat_id}",
        include_self=False,
    )


@socketio.on("read_messages")
def socket_read_messages(data):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        emit("error", {"error": "Не авторизован"})
        return

    chat_id = data.get("chat_id") if isinstance(data, dict) else None
    message_id = data.get("message_id") if isinstance(data, dict) else None

    if not chat_id or not str(chat_id).isdigit():
        emit("error", {"error": "chat_id обязателен"})
        return

    payload, error, status = MessageService.mark_read(
        chat_id=int(chat_id),
        user_id=user_id,
        up_to_message_id=int(message_id) if message_id and str(message_id).isdigit() else None,
    )

    if error:
        emit("error", error)
        return

    emit("messages_read", payload, room=f"chat_{chat_id}")


@socketio.on("presence_ping")
def socket_presence_ping():
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        return

    user = User.query.get(user_id)
    if not user:
        return

    user.mark_online()
    db.session.commit()
