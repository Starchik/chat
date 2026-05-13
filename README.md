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
- Аудиозвонки и видеозвонки 1:1 (WebRTC)
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
- WebRTC
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
│   │   ├── css/
│   │   ├── js/
│   │   ├── icons/
│   │   ├── manifest.json
│   │   ├── sw.js
│   │   └── uploads/
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

- `SECRET_KEY` (рекомендуется минимум 32 символа)
- `JWT_SECRET_KEY` (рекомендуется минимум 32 символа)
- `DATABASE_URL` (по умолчанию SQLite)
- `JWT_EXPIRES_DAYS`
- `MAX_CONTENT_LENGTH`
- `SOCKETIO_ASYNC_MODE`
- `CORS_ORIGINS`
- `VAPID_CLAIMS_SUB`
- `WEBRTC_RING_TIMEOUT_SEC`
- `WEBRTC_ENABLE_PUBLIC_STUN_FALLBACK`
- `WEBRTC_STUN_SERVERS`
- `WEBRTC_TURN_URLS` / `WEBRTC_TURN_URL`
- `WEBRTC_TURN_USERNAME`
- `WEBRTC_TURN_CREDENTIAL`
- `WEBRTC_ICE_SERVERS_JSON`
- `HOST`, `PORT`, `FLASK_DEBUG`

### WebRTC admin config (без JSON)

Базовый self-host конфиг можно сделать так:

```env
WEBRTC_ENABLE_PUBLIC_STUN_FALLBACK=1
WEBRTC_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
WEBRTC_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
WEBRTC_TURN_USERNAME=webrtc
WEBRTC_TURN_CREDENTIAL=strong-password
```

### WebRTC advanced JSON (опционально)

Если нужен тонкий контроль, можно добавить `WEBRTC_ICE_SERVERS_JSON`:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": "turn:turn.example.com:3478",
    "username": "webrtc",
    "credential": "strong-password"
  }
]
```

JSON и simple mode можно использовать вместе: сервер объединит их и уберет дубликаты.

## Self-host WebRTC (TURN/STUN)

Для звонков в локальных/корпоративных сетях одного STUN обычно недостаточно. Для production добавьте свой TURN-сервер (например, coturn) и укажите его через `WEBRTC_TURN_*` (или через JSON).

Короткий пример docker запуска coturn:

```bash
docker run -d --name coturn \
  -p 3478:3478 -p 3478:3478/udp \
  -p 5349:5349 -p 5349:5349/udp \
  coturn/coturn \
  -n --log-file=stdout \
  --lt-cred-mech --realm=example.com \
  --user=webrtc:strong-password
```

После этого добавьте TURN endpoint в `WEBRTC_TURN_URLS` или `WEBRTC_ICE_SERVERS_JSON`.

## Если IP динамический

Для динамического IP у self-host сценария рабочая схема такая:

1. Используйте домен + DDNS (Cloudflare API, DuckDNS, No-IP, Dynu), чтобы домен всегда указывал на актуальный IP.
2. В `WEBRTC_TURN_URLS` указывайте домен (`turn:turn.example.com:3478`), а не голый IP.
3. Для HTTPS/`turns:` используйте автоматические сертификаты (Caddy/Traefik/Nginx + Let's Encrypt).
4. На роутере включите проброс портов TURN (`3478` UDP/TCP и при необходимости `5349` TLS).
5. Если сервер за NAT, для coturn задайте `external-ip`; при динамическом IP обновляйте его скриптом при смене адреса и перезапускайте coturn.

Практически: для стабильного продакшна самый простой путь — маленький VPS со статическим IP под TURN.

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
- `call_invite`
- `call_accept`
- `call_reject`
- `call_end`
- `call_signal`

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
- `call_invite`
- `call_accept`
- `call_reject`
- `call_end`
- `call_signal`
- `call_error`

## Ограничения звонков

- Сейчас поддерживаются только личные (1:1) звонки.
- Групповые звонки пока не реализованы.

## Примечания

- База данных инициализируется автоматически при старте приложения.
- VAPID-ключи для push генерируются автоматически в `instance/` при первом запуске.
- Для production обязательно замените секреты в `.env`.
