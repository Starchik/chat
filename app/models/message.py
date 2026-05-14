from sqlalchemy import UniqueConstraint

from flask import current_app

from app.extensions import db
from app.utils import generate_image_preview, isoformat_or_none, preview_storage_name, utcnow


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    content = db.Column(db.Text, nullable=True)
    message_type = db.Column(db.String(20), nullable=False, default="text")
    reply_to_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_message_id = db.Column(
        db.Integer,
        db.ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )

    is_edited = db.Column(db.Boolean, nullable=False, default=False)
    edited_at = db.Column(db.DateTime(timezone=True), nullable=True)
    is_deleted = db.Column(db.Boolean, nullable=False, default=False)
    deleted_at = db.Column(db.DateTime(timezone=True), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )

    chat = db.relationship("Chat", back_populates="messages")
    sender = db.relationship("User", back_populates="sent_messages")
    reply_to = db.relationship(
        "Message",
        remote_side=[id],
        foreign_keys=[reply_to_id],
        post_update=True,
    )
    forwarded_from = db.relationship(
        "Message",
        remote_side=[id],
        foreign_keys=[forwarded_from_message_id],
        post_update=True,
    )

    attachments = db.relationship(
        "MessageAttachment",
        back_populates="message",
        cascade="all, delete-orphan",
        lazy="joined",
    )
    reads = db.relationship(
        "MessageRead",
        back_populates="message",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )

    def to_dict(self):
        sender = self.sender.to_dict() if self.sender else None
        forwarded_from_payload = None

        if self.forwarded_from:
            forwarded_sender = self.forwarded_from.sender.to_dict() if self.forwarded_from.sender else None
            forwarded_from_payload = {
                "id": self.forwarded_from.id,
                "chat_id": self.forwarded_from.chat_id,
                "sender_id": self.forwarded_from.sender_id,
                "sender": forwarded_sender,
                "content": self.forwarded_from.content,
            }

        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "sender": sender,
            "sender_id": self.sender_id,
            "content": self.content,
            "message_type": self.message_type,
            "reply_to_id": self.reply_to_id,
            "forwarded_from_message_id": self.forwarded_from_message_id,
            "forwarded_from": forwarded_from_payload,
            "is_edited": self.is_edited,
            "edited_at": isoformat_or_none(self.edited_at),
            "is_deleted": self.is_deleted,
            "deleted_at": isoformat_or_none(self.deleted_at),
            "created_at": isoformat_or_none(self.created_at),
            "updated_at": isoformat_or_none(self.updated_at),
            "attachments": [attachment.to_dict() for attachment in self.attachments],
            "read_by": [read.to_dict() for read in self.reads.all()],
        }


class MessageAttachment(db.Model):
    __tablename__ = "message_attachments"

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    uploader_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    file_name = db.Column(db.String(255), nullable=False)
    stored_name = db.Column(db.String(255), nullable=False, unique=True)
    file_url = db.Column(db.String(255), nullable=False)
    mime_type = db.Column(db.String(120), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    kind = db.Column(db.String(20), nullable=False, default="file")

    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    message = db.relationship("Message", back_populates="attachments")

    def _resolve_preview_url(self):
        if self.kind != "image" or not self.stored_name:
            return self.file_url

        preview_name = preview_storage_name(self.stored_name)
        if not preview_name:
            return self.file_url

        try:
            uploads_dir = current_app.config.get("FILE_UPLOAD_FOLDER")
            if uploads_dir is None:
                return self.file_url

            preview_path = uploads_dir / preview_name
            if preview_path.exists():
                return f"/static/uploads/files/{preview_name}"

            original_path = uploads_dir / self.stored_name
            generated = generate_image_preview(
                source_path=original_path,
                preview_path=preview_path,
                max_side=int(current_app.config.get("IMAGE_PREVIEW_MAX_SIDE", 720)),
                quality=int(current_app.config.get("IMAGE_PREVIEW_WEBP_QUALITY", 68)),
            )
            if generated and preview_path.exists():
                return f"/static/uploads/files/{preview_name}"
        except Exception:
            return self.file_url

        return self.file_url

    def to_dict(self):
        return {
            "id": self.id,
            "message_id": self.message_id,
            "uploader_id": self.uploader_id,
            "file_name": self.file_name,
            "stored_name": self.stored_name,
            "file_url": self.file_url,
            "preview_url": self._resolve_preview_url(),
            "mime_type": self.mime_type,
            "file_size": self.file_size,
            "kind": self.kind,
            "created_at": isoformat_or_none(self.created_at),
        }


class MessageRead(db.Model):
    __tablename__ = "message_reads"
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_message_user_read"),)

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    read_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    message = db.relationship("Message", back_populates="reads")

    def to_dict(self):
        return {
            "id": self.id,
            "message_id": self.message_id,
            "user_id": self.user_id,
            "read_at": isoformat_or_none(self.read_at),
        }


class PinnedMessage(db.Model):
    __tablename__ = "pinned_messages"

    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    pinned_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    chat = db.relationship("Chat", back_populates="pins")
    message = db.relationship("Message")

    def to_dict(self):
        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "message_id": self.message_id,
            "pinned_by_id": self.pinned_by_id,
            "created_at": isoformat_or_none(self.created_at),
        }
