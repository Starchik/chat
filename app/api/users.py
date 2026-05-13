from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from app.models import User


users_bp = Blueprint("users", __name__, url_prefix="/users")


@users_bp.get("/search")
@jwt_required()
def search_users():
    current_user_id = int(get_jwt_identity())
    query = (request.args.get("q") or "").strip()

    if len(query) < 1:
        return jsonify({"users": []})

    users = (
        User.query
        .filter(
            User.id != current_user_id,
            (User.username.ilike(f"%{query}%")) | (User.display_name.ilike(f"%{query}%")),
        )
        .order_by(User.is_online.desc(), User.display_name.asc())
        .limit(30)
        .all()
    )

    return jsonify({"users": [user.to_dict() for user in users]})


@users_bp.get("/<int:user_id>")
@jwt_required()
def get_user(user_id: int):
    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    return jsonify({"user": user.to_dict()})
