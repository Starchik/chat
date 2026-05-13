# Импортирует обработчики, чтобы зарегистрировать Socket.IO события.
from app.sockets import events  # noqa: F401


def register_sockets():
    return events
