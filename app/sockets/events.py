from collections import defaultdict

from flask import current_app, request
from flask_jwt_extended import decode_token
from flask_socketio import ConnectionRefusedError, emit, join_room, leave_room

from app.extensions import db, socketio
from app.models import ChatMembership, User
from app.services import MessageService


sid_to_user: dict[str, int] = {}
user_to_sids: dict[int, set[str]] = defaultdict(set)
active_calls: dict[str, dict] = {}
user_active_call: dict[int, str] = {}


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


def _get_other_participant(call: dict, user_id: int):
    if call.get("caller_id") == user_id:
        return call.get("callee_id")
    if call.get("callee_id") == user_id:
        return call.get("caller_id")
    return None


def _clear_call_session(session_id: str):
    call = active_calls.pop(session_id, None)
    if not call:
        return None

    for participant_id in (call.get("caller_id"), call.get("callee_id")):
        if participant_id and user_active_call.get(participant_id) == session_id:
            user_active_call.pop(participant_id, None)

    return call


def _emit_call_error(error_message: str):
    emit("call_error", {"error": error_message})


def _schedule_call_timeout(session_id: str, timeout_sec: int):
    def _worker():
        safe_timeout = timeout_sec if timeout_sec and timeout_sec > 0 else 45
        socketio.sleep(safe_timeout)

        call = active_calls.get(session_id)
        if not call or call.get("accepted"):
            return

        _clear_call_session(session_id)
        payload = {
            "session_id": session_id,
            "chat_id": call.get("chat_id"),
            "from_user_id": call.get("caller_id"),
            "reason": "timeout",
        }

        for participant_id in (call.get("caller_id"), call.get("callee_id")):
            if participant_id:
                socketio.emit("call_end", payload, room=f"user_{participant_id}")

    socketio.start_background_task(_worker)


def _validate_private_call(chat_id: int, caller_id: int, target_user_id: int):
    memberships = ChatMembership.query.filter(
        ChatMembership.chat_id == chat_id,
        ChatMembership.user_id.in_([caller_id, target_user_id]),
    ).all()

    if len(memberships) != 2:
        return False, "Доступ к чату запрещен"

    participants_count = ChatMembership.query.filter_by(chat_id=chat_id).count()
    if participants_count != 2:
        return False, "Групповые звонки пока не поддерживаются"

    return True, None


@socketio.on("connect")
def socket_connect(auth=None):
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

    active_session_id = user_active_call.get(user_id)
    if active_session_id:
        call = _clear_call_session(active_session_id)
        if call:
            peer_id = _get_other_participant(call, user_id)
            if peer_id:
                socketio.emit(
                    "call_end",
                    {
                        "session_id": active_session_id,
                        "chat_id": call.get("chat_id"),
                        "from_user_id": user_id,
                        "reason": "disconnected",
                    },
                    room=f"user_{peer_id}",
                )

    _broadcast_user_status(user_id, False)


@socketio.on("join_chat")
def socket_join_chat(data=None):
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
def socket_leave_chat(data=None):
    chat_id = data.get("chat_id") if isinstance(data, dict) else None
    if not chat_id or not str(chat_id).isdigit():
        emit("error", {"error": "chat_id обязателен"})
        return

    leave_room(f"chat_{chat_id}")
    emit("left_chat", {"chat_id": int(chat_id)})


@socketio.on("typing")
def socket_typing(data=None):
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
def socket_read_messages(data=None):
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
def socket_presence_ping(_data=None):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        return

    user = User.query.get(user_id)
    if not user:
        return

    user.mark_online()
    db.session.commit()


@socketio.on("call_invite")
def socket_call_invite(data=None):
    caller_id = sid_to_user.get(request.sid)
    if not caller_id:
        _emit_call_error("Не авторизован")
        return

    if not isinstance(data, dict):
        _emit_call_error("Некорректные данные звонка")
        return

    session_id = str(data.get("session_id") or "").strip()
    chat_id = data.get("chat_id")
    target_user_id = data.get("target_user_id")
    kind = str(data.get("kind") or "").strip().lower()
    offer = data.get("offer")

    if len(session_id) < 8 or len(session_id) > 128:
        _emit_call_error("Некорректный session_id")
        return

    if not chat_id or not str(chat_id).isdigit():
        _emit_call_error("chat_id обязателен")
        return

    if not target_user_id or not str(target_user_id).isdigit():
        _emit_call_error("target_user_id обязателен")
        return

    chat_id = int(chat_id)
    target_user_id = int(target_user_id)

    if target_user_id == caller_id:
        _emit_call_error("Нельзя позвонить самому себе")
        return

    if kind not in {"audio", "video"}:
        _emit_call_error("Неизвестный тип звонка")
        return

    if (
        not isinstance(offer, dict)
        or offer.get("type") != "offer"
        or not isinstance(offer.get("sdp"), str)
        or not offer.get("sdp")
    ):
        _emit_call_error("Некорректный SDP offer")
        return

    if session_id in active_calls:
        _emit_call_error("Звонок с таким session_id уже существует")
        return

    valid, error_message = _validate_private_call(chat_id, caller_id, target_user_id)
    if not valid:
        _emit_call_error(error_message)
        return

    if user_active_call.get(caller_id):
        _emit_call_error("У вас уже есть активный звонок")
        return

    if user_active_call.get(target_user_id):
        emit(
            "call_reject",
            {
                "session_id": session_id,
                "chat_id": chat_id,
                "from_user_id": target_user_id,
                "reason": "busy",
            },
        )
        return

    if not user_to_sids.get(target_user_id):
        emit(
            "call_reject",
            {
                "session_id": session_id,
                "chat_id": chat_id,
                "from_user_id": target_user_id,
                "reason": "offline",
            },
        )
        return

    caller = User.query.get(caller_id)
    caller_name = caller.display_name if caller else "Пользователь"

    active_calls[session_id] = {
        "session_id": session_id,
        "chat_id": chat_id,
        "kind": kind,
        "caller_id": caller_id,
        "callee_id": target_user_id,
        "accepted": False,
    }
    user_active_call[caller_id] = session_id
    user_active_call[target_user_id] = session_id

    socketio.emit(
        "call_invite",
        {
            "session_id": session_id,
            "chat_id": chat_id,
            "kind": kind,
            "offer": offer,
            "from_user_id": caller_id,
            "from_display_name": caller_name,
        },
        room=f"user_{target_user_id}",
    )

    ring_timeout_sec = int(current_app.config.get("WEBRTC_RING_TIMEOUT_SEC", 45))
    _schedule_call_timeout(session_id, ring_timeout_sec)


@socketio.on("call_accept")
def socket_call_accept(data=None):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        _emit_call_error("Не авторизован")
        return

    if not isinstance(data, dict):
        _emit_call_error("Некорректные данные звонка")
        return

    session_id = str(data.get("session_id") or "").strip()
    answer = data.get("answer")
    if not session_id:
        _emit_call_error("session_id обязателен")
        return

    if (
        not isinstance(answer, dict)
        or answer.get("type") != "answer"
        or not isinstance(answer.get("sdp"), str)
        or not answer.get("sdp")
    ):
        _emit_call_error("Некорректный SDP answer")
        return

    call = active_calls.get(session_id)
    if not call:
        _emit_call_error("Звонок не найден")
        return

    if user_id not in {call.get("caller_id"), call.get("callee_id")}:
        _emit_call_error("Доступ к звонку запрещен")
        return

    peer_id = _get_other_participant(call, user_id)
    if not peer_id:
        _emit_call_error("Не удалось определить собеседника")
        return

    call["accepted"] = True

    socketio.emit(
        "call_accept",
        {
            "session_id": session_id,
            "chat_id": call.get("chat_id"),
            "from_user_id": user_id,
            "answer": answer,
        },
        room=f"user_{peer_id}",
    )


@socketio.on("call_reject")
def socket_call_reject(data=None):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        _emit_call_error("Не авторизован")
        return

    if not isinstance(data, dict):
        _emit_call_error("Некорректные данные звонка")
        return

    session_id = str(data.get("session_id") or "").strip()
    reason = str(data.get("reason") or "rejected").strip().lower()
    if not session_id:
        _emit_call_error("session_id обязателен")
        return

    call = active_calls.get(session_id)
    if not call:
        return

    if user_id not in {call.get("caller_id"), call.get("callee_id")}:
        _emit_call_error("Доступ к звонку запрещен")
        return

    peer_id = _get_other_participant(call, user_id)
    _clear_call_session(session_id)

    if peer_id:
        socketio.emit(
            "call_reject",
            {
                "session_id": session_id,
                "chat_id": call.get("chat_id"),
                "from_user_id": user_id,
                "reason": reason,
            },
            room=f"user_{peer_id}",
        )


@socketio.on("call_end")
def socket_call_end(data=None):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        _emit_call_error("Не авторизован")
        return

    if not isinstance(data, dict):
        _emit_call_error("Некорректные данные звонка")
        return

    session_id = str(data.get("session_id") or "").strip()
    reason = str(data.get("reason") or "ended").strip().lower()
    if not session_id:
        _emit_call_error("session_id обязателен")
        return

    call = active_calls.get(session_id)
    if not call:
        return

    if user_id not in {call.get("caller_id"), call.get("callee_id")}:
        _emit_call_error("Доступ к звонку запрещен")
        return

    peer_id = _get_other_participant(call, user_id)
    _clear_call_session(session_id)

    if peer_id:
        socketio.emit(
            "call_end",
            {
                "session_id": session_id,
                "chat_id": call.get("chat_id"),
                "from_user_id": user_id,
                "reason": reason,
            },
            room=f"user_{peer_id}",
        )


@socketio.on("call_signal")
def socket_call_signal(data=None):
    user_id = sid_to_user.get(request.sid)
    if not user_id:
        _emit_call_error("Не авторизован")
        return

    if not isinstance(data, dict):
        _emit_call_error("Некорректные данные звонка")
        return

    session_id = str(data.get("session_id") or "").strip()
    candidate = data.get("candidate")
    if not session_id:
        _emit_call_error("session_id обязателен")
        return

    if not isinstance(candidate, dict):
        _emit_call_error("Некорректный ICE candidate")
        return

    call = active_calls.get(session_id)
    if not call:
        return

    if user_id not in {call.get("caller_id"), call.get("callee_id")}:
        _emit_call_error("Доступ к звонку запрещен")
        return

    peer_id = _get_other_participant(call, user_id)
    if not peer_id:
        return

    socketio.emit(
        "call_signal",
        {
            "session_id": session_id,
            "chat_id": call.get("chat_id"),
            "from_user_id": user_id,
            "candidate": candidate,
        },
        room=f"user_{peer_id}",
    )
