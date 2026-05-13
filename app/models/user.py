from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db
from app.utils import isoformat_or_none, utcnow


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), unique=True, nullable=False, index=True)
    email = db.Column(db.String(320), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    display_name = db.Column(db.String(64), nullable=False)
    bio = db.Column(db.String(255), nullable=True)
    avatar_path = db.Column(db.String(255), nullable=True)
    is_online = db.Column(db.Boolean, nullable=False, default=False)
    last_seen = db.Column(db.DateTime(timezone=True), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )

    memberships = db.relationship(
        "ChatMembership",
        back_populates="user",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )
    sent_messages = db.relationship("Message", back_populates="sender", lazy="dynamic")
    push_subscriptions = db.relationship(
        "PushSubscription",
        back_populates="user",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )

    def set_password(self, password: str):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    def mark_online(self):
        self.is_online = True
        self.last_seen = utcnow()

    def mark_offline(self):
        self.is_online = False
        self.last_seen = utcnow()

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "display_name": self.display_name,
            "bio": self.bio,
            "avatar_url": self.avatar_path,
            "is_online": self.is_online,
            "last_seen": isoformat_or_none(self.last_seen),
            "created_at": isoformat_or_none(self.created_at),
        }

