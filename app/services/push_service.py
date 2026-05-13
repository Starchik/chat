import json
from pathlib import Path

from pywebpush import WebPushException, webpush

from app.extensions import db
from app.models import ChatMembership, PushSubscription


class PushService:
    @staticmethod
    def is_enabled(app):
        key_path = Path(app.config["VAPID_PRIVATE_KEY_PATH"])
        return key_path.exists() and app.config.get("VAPID_PUBLIC_KEY")

    @staticmethod
    def send_to_user(app, user_id: int, payload: dict):
        if not PushService.is_enabled(app):
            return

        subscriptions = PushSubscription.query.filter_by(user_id=user_id).all()
        if not subscriptions:
            return

        private_key_path = app.config["VAPID_PRIVATE_KEY_PATH"]
        claims = {"sub": app.config["VAPID_CLAIMS_SUB"]}

        for sub in subscriptions:
            subscription_info = {
                "endpoint": sub.endpoint,
                "keys": {
                    "p256dh": sub.p256dh,
                    "auth": sub.auth,
                },
            }
            try:
                webpush(
                    subscription_info=subscription_info,
                    data=json.dumps(payload),
                    vapid_private_key=private_key_path,
                    vapid_claims=claims,
                    ttl=60,
                )
            except WebPushException:
                # Если подписка невалидна, удаляем ее.
                db.session.delete(sub)

        db.session.commit()

    @staticmethod
    def notify_chat_members(app, chat_id: int, sender_id: int, payload: dict):
        members = ChatMembership.query.filter(
            ChatMembership.chat_id == chat_id,
            ChatMembership.user_id != sender_id,
        ).all()
        for member in members:
            PushService.send_to_user(app, member.user_id, payload)
