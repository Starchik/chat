from flask import Blueprint

from app.api.auth import auth_bp
from app.api.chats import chats_bp
from app.api.messages import messages_bp
from app.api.push import push_bp
from app.api.system import system_bp
from app.api.users import users_bp


api_bp = Blueprint("api", __name__, url_prefix="/api")


def register_api(app):
    api_bp.register_blueprint(auth_bp)
    api_bp.register_blueprint(users_bp)
    api_bp.register_blueprint(chats_bp)
    api_bp.register_blueprint(messages_bp)
    api_bp.register_blueprint(push_bp)
    api_bp.register_blueprint(system_bp)

    app.register_blueprint(api_bp)
