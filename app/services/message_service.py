from typing import Optional

from app.extensions import db
from app.models import (
    Chat,
    ChatMembership,
    Message,
    MessageAttachment,
    MessageRead,
    PinnedMessage,
)
from app.utils import utcnow


class MessageService:
    @staticmethod
    def create_message(
        chat_id: int,
        sender_id: int,
        content: Optional[str] = None,
        message_type: str = "text",
        reply_to_id: Optional[int] = None,
        forwarded_from_message_id: Optional[int] = None,
        attachments_payload: Optional[list[dict]] = None,
    ):
        membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=sender_id).first()
        if not membership:
            return None, {"error": "Доступ к чату запрещен"}, 403

        attachments_payload = attachments_payload or []
        clean_content = (content or "").strip()
        if not clean_content and not attachments_payload:
            return None, {"error": "Сообщение не может быть пустым"}, 400

        reply_to = None
        if reply_to_id:
            reply_to = Message.query.filter_by(id=reply_to_id, chat_id=chat_id).first()
            if not reply_to:
                return None, {"error": "Сообщение для ответа не найдено"}, 404

        if forwarded_from_message_id:
            forwarded_from = Message.query.get(forwarded_from_message_id)
            if not forwarded_from:
                return None, {"error": "Источник пересылки не найден"}, 404

        msg_type = message_type
        if attachments_payload:
            has_image = any(item.get("kind") == "image" for item in attachments_payload)
            msg_type = "image" if has_image else "file"

        message = Message(
            chat_id=chat_id,
            sender_id=sender_id,
            content=clean_content or None,
            message_type=msg_type,
            reply_to_id=reply_to.id if reply_to else None,
            forwarded_from_message_id=forwarded_from_message_id,
        )
        db.session.add(message)
        db.session.flush()

        for payload in attachments_payload:
            db.session.add(
                MessageAttachment(
                    message_id=message.id,
                    uploader_id=sender_id,
                    file_name=payload["file_name"],
                    stored_name=payload["stored_name"],
                    file_url=payload["file_url"],
                    mime_type=payload["mime_type"],
                    file_size=payload["file_size"],
                    kind=payload["kind"],
                )
            )

        chat = Chat.query.get(chat_id)
        chat.last_message_at = utcnow()

        membership.last_read_message_id = message.id
        membership.last_read_at = utcnow()

        existing_read = MessageRead.query.filter_by(message_id=message.id, user_id=sender_id).first()
        if not existing_read:
            db.session.add(MessageRead(message_id=message.id, user_id=sender_id, read_at=utcnow()))

        db.session.commit()
        return Message.query.get(message.id), None, None

    @staticmethod
    def edit_message(message_id: int, user_id: int, new_content: str):
        message = Message.query.get(message_id)
        if not message:
            return None, {"error": "Сообщение не найдено"}, 404
        if message.sender_id != user_id:
            return None, {"error": "Можно редактировать только свои сообщения"}, 403
        if message.is_deleted:
            return None, {"error": "Сообщение уже удалено"}, 400

        clean_content = new_content.strip()
        if not clean_content and not message.attachments:
            return None, {"error": "Сообщение не может быть пустым"}, 400

        message.content = clean_content or None
        message.is_edited = True
        message.edited_at = utcnow()
        db.session.commit()
        return message, None, None

    @staticmethod
    def delete_message(message_id: int, user_id: int):
        message = Message.query.get(message_id)
        if not message:
            return {"error": "Сообщение не найдено"}, 404

        membership = ChatMembership.query.filter_by(chat_id=message.chat_id, user_id=user_id).first()
        if not membership:
            return {"error": "Доступ к чату запрещен"}, 403

        if message.sender_id != user_id and not membership.is_admin:
            return {"error": "Недостаточно прав для удаления"}, 403

        message.is_deleted = True
        message.deleted_at = utcnow()
        message.content = None
        db.session.commit()
        return {"ok": True, "message_id": message_id, "chat_id": message.chat_id}, None

    @staticmethod
    def forward_message(source_message_id: int, user_id: int, target_chat_id: int):
        source_message = Message.query.get(source_message_id)
        if not source_message:
            return None, {"error": "Исходное сообщение не найдено"}, 404

        source_membership = ChatMembership.query.filter_by(chat_id=source_message.chat_id, user_id=user_id).first()
        target_membership = ChatMembership.query.filter_by(chat_id=target_chat_id, user_id=user_id).first()
        if not source_membership or not target_membership:
            return None, {"error": "Доступ к чату запрещен"}, 403

        attachments_payload = [
            {
                "file_name": a.file_name,
                "stored_name": a.stored_name,
                "file_url": a.file_url,
                "mime_type": a.mime_type,
                "file_size": a.file_size,
                "kind": a.kind,
            }
            for a in source_message.attachments
        ]

        return MessageService.create_message(
            chat_id=target_chat_id,
            sender_id=user_id,
            content=source_message.content,
            message_type=source_message.message_type,
            reply_to_id=None,
            forwarded_from_message_id=source_message.id,
            attachments_payload=attachments_payload,
        )

    @staticmethod
    def pin_message(message_id: int, user_id: int):
        message = Message.query.get(message_id)
        if not message:
            return None, {"error": "Сообщение не найдено"}, 404

        membership = ChatMembership.query.filter_by(chat_id=message.chat_id, user_id=user_id).first()
        if not membership:
            return None, {"error": "Доступ к чату запрещен"}, 403

        pin = PinnedMessage(
            chat_id=message.chat_id,
            message_id=message.id,
            pinned_by_id=user_id,
        )
        db.session.add(pin)
        db.session.commit()
        return pin, None, None

    @staticmethod
    def unpin_message(message_id: int, user_id: int):
        message = Message.query.get(message_id)
        if not message:
            return {"error": "Сообщение не найдено"}, 404

        membership = ChatMembership.query.filter_by(chat_id=message.chat_id, user_id=user_id).first()
        if not membership:
            return {"error": "Доступ к чату запрещен"}, 403

        PinnedMessage.query.filter_by(chat_id=message.chat_id, message_id=message.id).delete()
        db.session.commit()
        return {"ok": True, "message_id": message_id}, None

    @staticmethod
    def mark_read(chat_id: int, user_id: int, up_to_message_id: Optional[int] = None):
        membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
        if not membership:
            return None, {"error": "Доступ к чату запрещен"}, 403

        latest_message = (
            Message.query
            .filter_by(chat_id=chat_id)
            .order_by(Message.id.desc())
            .first()
        )
        if not latest_message:
            return {"ok": True, "last_read_message_id": None}, None, None

        target_id = up_to_message_id or latest_message.id

        unread_messages = (
            Message.query
            .filter(
                Message.chat_id == chat_id,
                Message.id <= target_id,
                Message.is_deleted.is_(False),
            )
            .all()
        )

        for message in unread_messages:
            exists = MessageRead.query.filter_by(message_id=message.id, user_id=user_id).first()
            if not exists:
                db.session.add(
                    MessageRead(
                        message_id=message.id,
                        user_id=user_id,
                        read_at=utcnow(),
                    )
                )

        membership.last_read_message_id = target_id
        membership.last_read_at = utcnow()
        db.session.commit()

        return {
            "ok": True,
            "chat_id": chat_id,
            "user_id": user_id,
            "last_read_message_id": target_id,
        }, None, None
