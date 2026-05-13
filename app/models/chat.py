from sqlalchemy import UniqueConstraint

from app.extensions import db
from app.utils import isoformat_or_none, utcnow


class Chat(db.Model):
    __tablename__ = "chats"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(120), nullable=True)
    description = db.Column(db.String(255), nullable=True)
    avatar_path = db.Column(db.String(255), nullable=True)
    is_group = db.Column(db.Boolean, nullable=False, default=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_message_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )

    memberships = db.relationship(
        "ChatMembership",
        back_populates="chat",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )
    messages = db.relationship(
        "Message",
        back_populates="chat",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )
    pins = db.relationship(
        "PinnedMessage",
        back_populates="chat",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "avatar_url": self.avatar_path,
            "is_group": self.is_group,
            "created_by_id": self.created_by_id,
            "last_message_at": isoformat_or_none(self.last_message_at),
            "created_at": isoformat_or_none(self.created_at),
        }


class ChatMembership(db.Model):
    __tablename__ = "chat_memberships"
    __table_args__ = (UniqueConstraint("chat_id", "user_id", name="uq_chat_user"),)

    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    is_archived = db.Column(db.Boolean, nullable=False, default=False)
    joined_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    last_read_message_id = db.Column(db.Integer, db.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    last_read_at = db.Column(db.DateTime(timezone=True), nullable=True)

    chat = db.relationship("Chat", back_populates="memberships")
    user = db.relationship("User", back_populates="memberships")

    def to_dict(self):
        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "user_id": self.user_id,
            "is_admin": self.is_admin,
            "is_archived": self.is_archived,
            "joined_at": isoformat_or_none(self.joined_at),
            "last_read_message_id": self.last_read_message_id,
            "last_read_at": isoformat_or_none(self.last_read_at),
        }
