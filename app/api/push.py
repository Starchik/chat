from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from app.extensions import db
from app.models import PushSubscription


push_bp = Blueprint("push", __name__, url_prefix="/push")


@push_bp.get("/public-key")
@jwt_required(optional=True)
def get_public_key():
    return jsonify({"public_key": current_app.config.get("VAPID_PUBLIC_KEY")})


@push_bp.post("/subscribe")
@jwt_required()
def subscribe_push():
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}

    endpoint = (data.get("endpoint") or "").strip()
    keys = data.get("keys") or {}
    p256dh = (keys.get("p256dh") or "").strip()
    auth = (keys.get("auth") or "").strip()

    if not endpoint or not p256dh or not auth:
        return jsonify({"error": "Некорректный объект подписки"}), 400

    subscription = PushSubscription.query.filter_by(endpoint=endpoint).first()
    if not subscription:
        subscription = PushSubscription(
            user_id=user_id,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
        )
        db.session.add(subscription)
    else:
        subscription.user_id = user_id
        subscription.p256dh = p256dh
        subscription.auth = auth

    db.session.commit()
    return jsonify({"subscription": subscription.to_dict()})


@push_bp.post("/unsubscribe")
@jwt_required()
def unsubscribe_push():
    user_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    endpoint = (data.get("endpoint") or "").strip()

    if not endpoint:
        return jsonify({"error": "endpoint обязателен"}), 400

    deleted = (
        PushSubscription.query
        .filter_by(user_id=user_id, endpoint=endpoint)
        .delete()
    )
    db.session.commit()

    return jsonify({"ok": True, "deleted": deleted})
