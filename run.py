import os
import sys


def _normalize_async_mode(value: str) -> str:
    normalized = (value or "").strip().lower()
    allowed = {"threading", "eventlet", "gevent", "gevent_uwsgi"}
    if normalized in allowed:
        return normalized
    return "threading"


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _prepare_async_mode() -> None:
    requested_mode = _normalize_async_mode(os.getenv("SOCKETIO_ASYNC_MODE", "threading"))
    force_eventlet = _env_bool("SOCKETIO_FORCE_EVENTLET", False)

    if requested_mode != "eventlet":
        os.environ["SOCKETIO_ASYNC_MODE"] = requested_mode
        return

    if sys.version_info >= (3, 12) and not force_eventlet:
        os.environ["SOCKETIO_ASYNC_MODE"] = "threading"
        print(
            "[startup] Python 3.12+ detected, using threading. "
            "Set SOCKETIO_FORCE_EVENTLET=1 to force eventlet."
        )
        return

    try:
        import eventlet  # noqa: F401

        eventlet.monkey_patch()
        os.environ["SOCKETIO_ASYNC_MODE"] = "eventlet"
    except Exception as exc:
        os.environ["SOCKETIO_ASYNC_MODE"] = "threading"
        print(f"[startup] eventlet unavailable, fallback to threading: {exc}")


_prepare_async_mode()

from app import create_app
from app.extensions import socketio


app = create_app()


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    allow_unsafe_werkzeug = app.config.get("SOCKETIO_ASYNC_MODE") == "threading"

    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=allow_unsafe_werkzeug,
    )
