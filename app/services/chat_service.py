from sqlalchemy import func

from app.extensions import db
from app.models import Chat, ChatMembership, Message, PinnedMessage, User
from app.utils import isoformat_or_none, utcnow


class ChatService:
    @staticmethod
    def get_membership(chat_id: int, user_id: int):
        return ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()

    @staticmethod
    def require_membership(chat_id: int, user_id: int):
        membership = ChatService.get_membership(chat_id, user_id)
        if not membership:
            return None, {"error": "Доступ к чату запрещен"}, 403
        return membership, None, None

    @staticmethod
    def list_user_chats(user_id: int, include_archived: bool = False):
        query = (
            Chat.query
            .join(ChatMembership, ChatMembership.chat_id == Chat.id)
            .filter(ChatMembership.user_id == user_id)
        )
        if include_archived:
            query = query.filter(ChatMembership.is_archived.is_(True))
        else:
            query = query.filter(ChatMembership.is_archived.is_(False))
        return query.order_by(Chat.last_message_at.desc()).all()

    @staticmethod
    def serialize_chat_for_user(chat: Chat, user_id: int):
        membership = ChatMembership.query.filter_by(chat_id=chat.id, user_id=user_id).first()
        member_items = (
            ChatMembership.query
            .filter_by(chat_id=chat.id)
            .join(User, User.id == ChatMembership.user_id)
            .all()
        )

        members = [
            {
                "id": item.user.id,
                "username": item.user.username,
                "display_name": item.user.display_name,
                "avatar_url": item.user.avatar_path,
                "is_online": item.user.is_online,
                "is_admin": item.is_admin,
            }
            for item in member_items
        ]

        title = chat.title
        avatar_url = chat.avatar_path
        online = False

        if not chat.is_group:
            other_member = next((m for m in members if m["id"] != user_id), None)
            if other_member:
                title = other_member["display_name"]
                avatar_url = other_member["avatar_url"]
                online = other_member["is_online"]

        last_message = (
            Message.query
            .filter_by(chat_id=chat.id)
            .order_by(Message.created_at.desc())
            .first()
        )

        unread_count = 0
        if membership and membership.last_read_message_id:
            unread_count = (
                Message.query
                .filter(
                    Message.chat_id == chat.id,
                    Message.id > membership.last_read_message_id,
                    Message.sender_id != user_id,
                    Message.is_deleted.is_(False),
                )
                .count()
            )
        elif membership:
            unread_count = (
                Message.query
                .filter(
                    Message.chat_id == chat.id,
                    Message.sender_id != user_id,
                    Message.is_deleted.is_(False),
                )
                .count()
            )

        pinned = (
            PinnedMessage.query
            .filter_by(chat_id=chat.id)
            .order_by(PinnedMessage.created_at.desc())
            .first()
        )

        payload = chat.to_dict()
        payload.update(
            {
                "title": title,
                "avatar_url": avatar_url,
                "online": online,
                "members": members,
                "member_count": len(members),
                "unread_count": unread_count,
                "last_message": last_message.to_dict() if last_message else None,
                "pinned_message": pinned.message.to_dict() if pinned else None,
                "is_archived": membership.is_archived if membership else False,
                "last_read_message_id": membership.last_read_message_id if membership else None,
                "last_read_at": isoformat_or_none(membership.last_read_at) if membership else None,
            }
        )
        return payload

    @staticmethod
    def create_private_chat(current_user_id: int, target_user_id: int):
        if current_user_id == target_user_id:
            return None, {"error": "Нельзя создать личный чат с самим собой"}, 400

        target = User.query.get(target_user_id)
        if not target:
            return None, {"error": "Пользователь не найден"}, 404

        candidate_chats = (
            Chat.query
            .filter(Chat.is_group.is_(False))
            .join(ChatMembership, ChatMembership.chat_id == Chat.id)
            .filter(ChatMembership.user_id.in_([current_user_id, target_user_id]))
            .group_by(Chat.id)
            .having(func.count(ChatMembership.user_id) == 2)
            .all()
        )

        for chat in candidate_chats:
            member_ids = {m.user_id for m in chat.memberships.all()}
            if member_ids == {current_user_id, target_user_id}:
                return chat, None, None

        chat = Chat(is_group=False, created_by_id=current_user_id, title=None, last_message_at=utcnow())
        db.session.add(chat)
        db.session.flush()

        db.session.add(
            ChatMembership(
                chat_id=chat.id,
                user_id=current_user_id,
                is_admin=False,
            )
        )
        db.session.add(
            ChatMembership(
                chat_id=chat.id,
                user_id=target_user_id,
                is_admin=False,
            )
        )

        db.session.commit()
        return chat, None, None

    @staticmethod
    def create_group_chat(title: str, creator_id: int, member_ids: list[int], description: str | None = None):
        cleaned_ids = {int(member_id) for member_id in member_ids if str(member_id).isdigit()}
        cleaned_ids.add(creator_id)

        users = User.query.filter(User.id.in_(cleaned_ids)).all()
        if len(users) != len(cleaned_ids):
            return None, {"error": "Не все участники найдены"}, 404

        chat = Chat(
            title=title.strip(),
            description=(description or "").strip() or None,
            is_group=True,
            created_by_id=creator_id,
            last_message_at=utcnow(),
        )
        db.session.add(chat)
        db.session.flush()

        for user in users:
            db.session.add(
                ChatMembership(
                    chat_id=chat.id,
                    user_id=user.id,
                    is_admin=(user.id == creator_id),
                )
            )

        db.session.commit()
        return chat, None, None

    @staticmethod
    def archive_chat(chat_id: int, user_id: int, archive: bool):
        membership = ChatMembership.query.filter_by(chat_id=chat_id, user_id=user_id).first()
        if not membership:
            return {"error": "Доступ к чату запрещен"}, 403

        membership.is_archived = archive
        db.session.commit()
        return {"ok": True, "is_archived": membership.is_archived}, None

