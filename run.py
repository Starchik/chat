import os

# Eventlet нужен для production-ready long polling/WebSocket в Docker.
try:
    import eventlet

    eventlet.monkey_patch()
except Exception:
    eventlet = None

from app import create_app
from app.extensions import socketio


app = create_app()


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"

    socketio.run(app, host=host, port=port, debug=debug)
