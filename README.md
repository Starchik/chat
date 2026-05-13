# Flask Messenger (Telegram Web style)

Полноценный веб-мессенджер на **Flask + Socket.IO** с интерфейсом в стиле Telegram Web.

## Возможности

- Регистрация и вход (JWT)
- Пароли только в хешированном виде
- Личные и групповые чаты
- Отправка текста, фото и файлов
- Ответы, редактирование, удаление, пересылка, закрепление сообщений
- Онлайн-статусы и `печатает...`
- Read receipts (прочитанные сообщения)
- Сортировка чатов по активности
- Lazy loading и бесконечная прокрутка истории
- Поиск пользователей
- Аватары пользователей
- Архивация чатов
- REST API + WebSocket
- Тёмная/светлая тема
- Адаптивный интерфейс (desktop/mobile)
- PWA + Service Worker + Push (Web Push)
- Кэширование в LocalStorage
- Docker-ready запуск

## Стек

- Python 3.12
- Flask
- Flask-SQLAlchemy
- Flask-JWT-Extended
- Flask-SocketIO
- SQLite
- HTML/CSS/JavaScript

## Структура проекта

```text
.
├── app
│   ├── __init__.py
│   ├── config.py
│   ├── extensions.py
│   ├── utils.py
│   ├── api
│   │   ├── __init__.py
│   │   ├── auth.py
│   │   ├── chats.py
│   │   ├── messages.py
│   │   ├── push.py
│   │   └── users.py
│   ├── models
│   │   ├── __init__.py
│   │   ├── chat.py
│   │   ├── message.py
│   │   ├── push_subscription.py
│   │   └── user.py
│   ├── services
│   │   ├── __init__.py
│   │   ├── chat_service.py
│   │   ├── message_service.py
│   │   └── push_service.py
│   ├── sockets
│   │   ├── __init__.py
│   │   └── events.py
│   ├── static
│   │   ├── css/style.css
│   │   ├── js/api.js
│   │   ├── js/auth.js
│   │   ├── js/chat.js
│   │   ├── js/config.js
│   │   ├── js/storage.js
│   │   ├── js/sw-register.js
│   │   ├── icons/icon-192.svg
│   │   ├── icons/icon-512.svg
│   │   ├── manifest.json
│   │   ├── sw.js
│   │   └── uploads
│   │       ├── avatars/.gitkeep
│   │       ├── files/.gitkeep
│   │       └── .gitkeep
│   └── templates
│       ├── base.html
│       ├── chat.html
│       ├── login.html
│       └── register.html
├── instance/
├── .env
├── .env.example
├── .gitignore
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── run.py
└── start.sh
```

## Запуск через Docker (рекомендуется)

```bash
docker compose up --build
```

После запуска:

- Приложение: `http://localhost:5000`
- Health-check: `http://localhost:5000/health`

## Локальный запуск без Docker

```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

## Переменные окружения

Используется файл `.env`:

- `SECRET_KEY`
- `JWT_SECRET_KEY`
- `DATABASE_URL` (по умолчанию SQLite)
- `JWT_EXPIRES_DAYS`
- `SOCKETIO_ASYNC_MODE`
- `VAPID_CLAIMS_SUB`
- `HOST`, `PORT`, `FLASK_DEBUG`

## API (кратко)

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/avatar`
- `GET /api/users/search?q=`
- `GET /api/chats`
- `POST /api/chats`
- `GET /api/chats/<chat_id>/messages`
- `POST /api/chats/<chat_id>/read`
- `PATCH /api/chats/<chat_id>/archive`
- `POST /api/messages`
- `PUT /api/messages/<message_id>`
- `DELETE /api/messages/<message_id>`
- `POST /api/messages/<message_id>/forward`
- `POST /api/messages/<message_id>/pin`
- `DELETE /api/messages/<message_id>/pin`

JWT передается в заголовке:

```http
Authorization: Bearer <token>
```

## Socket.IO события

Клиент -> сервер:

- `join_chat`
- `leave_chat`
- `typing`
- `read_messages`
- `presence_ping`

Сервер -> клиент:

- `connected`
- `new_message`
- `message_updated`
- `message_deleted`
- `message_pinned`
- `message_unpinned`
- `chat_updated`
- `typing`
- `messages_read`
- `user_status`

## Примечания

- База данных инициализируется автоматически при старте приложения.
- VAPID-ключи для push генерируются автоматически в `instance/` при первом запуске.
- Для production рекомендуется заменить секреты в `.env`.
