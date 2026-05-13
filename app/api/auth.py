from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required

from app.extensions import db
from app.models import User
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


@auth_bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}

    username = (data.get("username") or "").strip().lower()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()

    if len(username) < 3 or len(username) > 32:
        return jsonify({"error": "Username должен быть от 3 до 32 символов"}), 400
    if "@" not in email or len(email) > 320:
        return jsonify({"error": "Некорректный email"}), 400
    if len(password) < 6:
        return jsonify({"error": "Пароль должен быть минимум 6 символов"}), 400
    if len(display_name) < 2:
        return jsonify({"error": "Display name должен быть минимум 2 символа"}), 400

    existing_username = User.query.filter_by(username=username).first()
    if existing_username:
        return jsonify({"error": "Username уже занят"}), 409

    existing_email = User.query.filter_by(email=email).first()
    if existing_email:
        return jsonify({"error": "Email уже зарегистрирован"}), 409

    user = User(
        username=username,
        email=email,
        display_name=display_name,
    )
    user.set_password(password)

    db.session.add(user)
    db.session.commit()

    return jsonify(_token_response(user)), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}

    login_value = (data.get("login") or "").strip().lower()
    password = data.get("password") or ""

    if not login_value or not password:
        return jsonify({"error": "Введите логин и пароль"}), 400

    user = User.query.filter(
        (User.username == login_value) | (User.email == login_value)
    ).first()

    if not user or not user.check_password(password):
        return jsonify({"error": "Неверные учетные данные"}), 401

    return jsonify(_token_response(user))


@auth_bp.get("/me")
@jwt_required()
def me():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    return jsonify({"user": user.to_dict()})


@auth_bp.post("/avatar")
@jwt_required()
def upload_avatar():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404

    if "avatar" not in request.files:
        return jsonify({"error": "Файл avatar не передан"}), 400

    avatar = request.files["avatar"]
    if not avatar.filename:
        return jsonify({"error": "Пустое имя файла"}), 400

    if not is_allowed_file(avatar.filename, current_app.config["ALLOWED_IMAGE_EXTENSIONS"]):
        return jsonify({"error": "Неподдерживаемый формат изображения"}), 400

    safe_name = sanitize_filename(avatar.filename)
    stored_name = make_storage_filename(safe_name)
    destination = current_app.config["AVATAR_UPLOAD_FOLDER"] / stored_name

    avatar.save(destination)

    user.avatar_path = f"/static/uploads/avatars/{stored_name}"
    db.session.commit()

    return jsonify({"avatar_url": user.avatar_path, "user": user.to_dict()})
