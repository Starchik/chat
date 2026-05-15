from __future__ import annotations

from typing import Optional

from flask import current_app, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


def _serializer() -> URLSafeTimedSerializer:
    secret_key = str(current_app.config.get("ATTACHMENT_AUTH_SECRET") or current_app.config["SECRET_KEY"])
    salt = str(current_app.config.get("ATTACHMENT_AUTH_SALT") or "chat-attachment-auth")
    return URLSafeTimedSerializer(secret_key=secret_key, salt=salt)


def issue_attachment_cookie(response, user_id: int):
    serializer = _serializer()
    token = serializer.dumps({"uid": int(user_id)})

    cookie_name = str(current_app.config.get("ATTACHMENT_AUTH_COOKIE_NAME") or "chat_attachment_auth")
    cookie_path = str(current_app.config.get("ATTACHMENT_AUTH_COOKIE_PATH") or "/api/messages/attachments")
    max_age = int(current_app.config.get("ATTACHMENT_AUTH_MAX_AGE") or (7 * 24 * 60 * 60))
    secure = bool(current_app.config.get("ATTACHMENT_AUTH_SECURE", False))
    samesite = str(current_app.config.get("ATTACHMENT_AUTH_SAMESITE") or "Lax")
    domain = current_app.config.get("ATTACHMENT_AUTH_DOMAIN")

    response.set_cookie(
        cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite=samesite,
        path=cookie_path,
        domain=domain,
    )
    return response


def clear_attachment_cookie(response):
    cookie_name = str(current_app.config.get("ATTACHMENT_AUTH_COOKIE_NAME") or "chat_attachment_auth")
    cookie_path = str(current_app.config.get("ATTACHMENT_AUTH_COOKIE_PATH") or "/api/messages/attachments")
    domain = current_app.config.get("ATTACHMENT_AUTH_DOMAIN")
    response.delete_cookie(cookie_name, path=cookie_path, domain=domain)
    return response


def get_attachment_user_id_from_cookie() -> Optional[int]:
    cookie_name = str(current_app.config.get("ATTACHMENT_AUTH_COOKIE_NAME") or "chat_attachment_auth")
    token = request.cookies.get(cookie_name)
    if not token:
        return None

    serializer = _serializer()
    max_age = int(current_app.config.get("ATTACHMENT_AUTH_MAX_AGE") or (7 * 24 * 60 * 60))

    try:
        payload = serializer.loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None

    if not isinstance(payload, dict):
        return None

    uid = payload.get("uid")
    try:
        parsed = int(uid)
    except (TypeError, ValueError):
        return None

    return parsed if parsed > 0 else None
