from typing import Optional

import shutil

from flask import current_app

from app.extensions import db
from app.models import (
    Chat,
    ChatMembership,
    Message,
    MessageAttachment,
    MessageRead,
    PinnedMessage,
)
from app.utils import make_storage_filename, preview_storage_name, utcnow


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
            return {"error": "\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e"}, 404

        membership = ChatMembership.query.filter_by(chat_id=message.chat_id, user_id=user_id).first()
        if not membership:
            return {"error": "\u0414\u043e\u0441\u0442\u0443\u043f \u043a \u0447\u0430\u0442\u0443 \u0437\u0430\u043f\u0440\u0435\u0449\u0435\u043d"}, 403

        if message.sender_id != user_id and not membership.is_admin:
            return {"error": "\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u043f\u0440\u0430\u0432 \u0434\u043b\u044f \u0443\u0434\u0430\u043b\u0435\u043d\u0438\u044f"}, 403

        attachment_file_paths = []
        for attachment in list(message.attachments):
            if attachment.stored_name:
                upload_folder = current_app.config["FILE_UPLOAD_FOLDER"]
                attachment_file_paths.append(upload_folder / attachment.stored_name)
                preview_name = preview_storage_name(attachment.stored_name)
                if preview_name:
                    attachment_file_paths.append(upload_folder / preview_name)
            db.session.delete(attachment)

        PinnedMessage.query.filter_by(chat_id=message.chat_id, message_id=message.id).delete()

        message.is_deleted = True
        message.deleted_at = utcnow()
        message.content = None
        message.message_type = "text"
        db.session.commit()

        for path in attachment_file_paths:
            try:
                if path.exists():
                    path.unlink()
            except Exception:
                # Message must stay deleted even if physical cleanup fails.
                pass

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

        attachments_payload = []
        copied_paths = []
        upload_folder = current_app.config["FILE_UPLOAD_FOLDER"]

        try:
            for attachment in source_message.attachments:
                source_stored_name = (attachment.stored_name or "").strip()
                if not source_stored_name:
                    continue

                source_path = upload_folder / source_stored_name
                if not source_path.exists():
                    raise FileNotFoundError(source_stored_name)

                seed_name = attachment.file_name or source_stored_name
                new_stored_name = make_storage_filename(seed_name)
                target_path = upload_folder / new_stored_name
                while target_path.exists():
                    new_stored_name = make_storage_filename(seed_name)
                    target_path = upload_folder / new_stored_name

                shutil.copy2(source_path, target_path)
                copied_paths.append(target_path)

                source_preview_name = preview_storage_name(source_stored_name)
                target_preview_name = preview_storage_name(new_stored_name)
                if source_preview_name and target_preview_name:
                    source_preview_path = upload_folder / source_preview_name
                    target_preview_path = upload_folder / target_preview_name
                    if source_preview_path.exists():
                        shutil.copy2(source_preview_path, target_preview_path)
                        copied_paths.append(target_preview_path)

                file_size = int(target_path.stat().st_size) if target_path.exists() else int(attachment.file_size or 0)

                attachments_payload.append(
                    {
                        "file_name": attachment.file_name,
                        "stored_name": new_stored_name,
                        "file_url": f"/static/uploads/files/{new_stored_name}",
                        "mime_type": attachment.mime_type,
                        "file_size": file_size,
                        "kind": attachment.kind,
                    }
                )
        except FileNotFoundError:
            for path in copied_paths:
                try:
                    if path.exists():
                        path.unlink()
                except Exception:
                    pass
            return None, {"error": "Не удалось переслать вложение: исходный файл не найден"}, 409
        except Exception:
            for path in copied_paths:
                try:
                    if path.exists():
                        path.unlink()
                except Exception:
                    pass
            return None, {"error": "Не удалось подготовить вложения для пересылки"}, 500

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

        existing_pin = PinnedMessage.query.filter_by(chat_id=message.chat_id, message_id=message.id).first()
        if existing_pin:
            return existing_pin, None, None

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
        return {"ok": True, "chat_id": message.chat_id, "message_id": message_id}, None

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
