from flask_jwt_extended import JWTManager
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO


db = SQLAlchemy()
jwt = JWTManager()
socketio = SocketIO(manage_session=False)


def init_extensions(app):
    db.init_app(app)
    jwt.init_app(app)
    socketio.init_app(
        app,
        cors_allowed_origins=app.config["CORS_ORIGINS"],
        async_mode=app.config["SOCKETIO_ASYNC_MODE"],
    )
