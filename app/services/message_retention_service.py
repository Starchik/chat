from datetime import timedelta

from sqlalchemy import func

from app.extensions import db
from app.models import Chat, Message
from app.utils import preview_storage_name, utcnow


def _collect_attachment_paths(message, upload_folder):
    paths = []

    for attachment in message.attachments:
        stored_name = (attachment.stored_name or "").strip()
        if not stored_name:
            continue
        paths.append(upload_folder / stored_name)

        preview_name = preview_storage_name(stored_name)
        if preview_name:
            paths.append(upload_folder / preview_name)

    return paths


def _recompute_chat_last_message_at(chat_ids):
    for chat_id in chat_ids:
        chat = Chat.query.get(chat_id)
        if not chat:
            continue

        last_message_at = (
            db.session.query(func.max(Message.created_at))
            .filter(Message.chat_id == chat_id)
            .scalar()
        )
        chat.last_message_at = last_message_at or chat.created_at or utcnow()

    db.session.commit()


def cleanup_expired_messages(app=None) -> dict:
    from flask import current_app

    target_app = app or current_app
    enabled = bool(target_app.config.get("MESSAGE_RETENTION_ENABLED", False))

    if not enabled:
        return {"enabled": False, "deleted_messages": 0, "deleted_files": 0, "affected_chats": 0}

    retention_days = int(target_app.config.get("MESSAGE_RETENTION_DAYS", 0) or 0)
    if retention_days <= 0:
        return {"enabled": True, "deleted_messages": 0, "deleted_files": 0, "affected_chats": 0}

    batch_size = max(10, int(target_app.config.get("MESSAGE_RETENTION_BATCH_SIZE", 500) or 500))
    max_batches = max(1, int(target_app.config.get("MESSAGE_RETENTION_MAX_BATCHES_PER_RUN", 5) or 5))
    threshold = utcnow() - timedelta(days=retention_days)

    deleted_messages = 0
    deleted_files = 0
    affected_chats = set()
    file_paths_to_delete = set()
    upload_folder = target_app.config["FILE_UPLOAD_FOLDER"]

    for _ in range(max_batches):
        expired_messages = (
            Message.query
            .filter(Message.created_at < threshold)
            .order_by(Message.id.asc())
            .limit(batch_size)
            .all()
        )

        if not expired_messages:
            break

        for message in expired_messages:
            affected_chats.add(int(message.chat_id))
            for path in _collect_attachment_paths(message, upload_folder):
                file_paths_to_delete.add(path)
            db.session.delete(message)

        deleted_messages += len(expired_messages)
        db.session.commit()

        if len(expired_messages) < batch_size:
            break

    if affected_chats:
        _recompute_chat_last_message_at(affected_chats)

    for path in file_paths_to_delete:
        try:
            if path.exists():
                path.unlink()
                deleted_files += 1
        except Exception:
            # DB cleanup is primary; file cleanup is best-effort.
            pass

    return {
        "enabled": True,
        "deleted_messages": deleted_messages,
        "deleted_files": deleted_files,
        "affected_chats": len(affected_chats),
    }
