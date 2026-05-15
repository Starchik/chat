from pathlib import Path

from flask import Blueprint, current_app, jsonify, make_response, request
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required

from app.extensions import db
from app.models import User
from app.security.attachment_access import clear_attachment_cookie, issue_attachment_cookie
from app.utils import (
    is_allowed_file,
    make_storage_filename,
    sanitize_filename,
)


auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def _token_response(user):
    access_token = create_access_token(identity=str(user.id))
    return {
        "access_token": access_token,
        "user": user.to_dict(),
    }


def _auth_success_response(user, status_code: int = 200):
    response = make_response(jsonify(_token_response(user)), status_code)
    issue_attachment_cookie(response, user.id)
    return response


@auth_bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}

    username = (data.get("username") or "").strip().lower()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()

    if len(username) < 3 or len(username) > 32:
        return jsonify({"error": "Username must be 3..32 chars"}), 400
    if "@" not in email or len(email) > 320:
        return jsonify({"error": "Invalid email"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 chars"}), 400
    if len(display_name) < 2:
        return jsonify({"error": "Display name must be at least 2 chars"}), 400

    existing_username = User.query.filter_by(username=username).first()
    if existing_username:
        return jsonify({"error": "Username already in use"}), 409

    existing_email = User.query.filter_by(email=email).first()
    if existing_email:
        return jsonify({"error": "Email already registered"}), 409

    user = User(
        username=username,
        email=email,
        display_name=display_name,
    )
    user.set_password(password)

    db.session.add(user)
    db.session.commit()

    return _auth_success_response(user, status_code=201)


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}

    login_value = (data.get("login") or "").strip().lower()
    password = data.get("password") or ""

    if not login_value or not password:
        return jsonify({"error": "Provide login and password"}), 400

    user = User.query.filter(
        (User.username == login_value) | (User.email == login_value)
    ).first()

    if not user or not user.check_password(password):
        return jsonify({"error": "Invalid credentials"}), 401

    return _auth_success_response(user)


@auth_bp.get("/me")
@jwt_required()
def me():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    response = jsonify({"user": user.to_dict()})
    issue_attachment_cookie(response, user.id)
    return response


@auth_bp.post("/logout")
def logout():
    response = jsonify({"ok": True})
    clear_attachment_cookie(response)
    return response


@auth_bp.post("/avatar")
@jwt_required()
def upload_avatar():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    if "avatar" not in request.files:
        return jsonify({"error": "Avatar file is missing"}), 400

    avatar = request.files["avatar"]
    if not avatar.filename:
        return jsonify({"error": "Empty filename"}), 400

    if not is_allowed_file(avatar.filename, current_app.config["ALLOWED_IMAGE_EXTENSIONS"]):
        return jsonify({"error": "Unsupported image format"}), 400

    safe_name = sanitize_filename(avatar.filename)
    stored_name = make_storage_filename(safe_name)
    destination = current_app.config["AVATAR_UPLOAD_FOLDER"] / stored_name
    previous_avatar_path = (user.avatar_path or "").strip()

    avatar.save(destination)

    user.avatar_path = f"/static/uploads/avatars/{stored_name}"
    db.session.commit()

    if previous_avatar_path.startswith("/static/uploads/avatars/"):
        old_name = Path(previous_avatar_path).name
        old_path = current_app.config["AVATAR_UPLOAD_FOLDER"] / old_name
        if old_path != destination:
            try:
                if old_path.exists():
                    old_path.unlink()
            except Exception:
                # Avatar update should succeed even if old file cleanup fails.
                pass

    return jsonify({"avatar_url": user.avatar_path, "user": user.to_dict()})
