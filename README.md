# Flask Messenger

Веб-мессенджер на Flask + Socket.IO с личными/групповыми чатами, файлами, PWA и 1:1 WebRTC звонками (аудио/видео).

## Что уже готово для production

- `docker-compose.yml` поднимает сразу 3 сервиса:
1. `messenger` (приложение)
2. `caddy` (reverse proxy + HTTPS сертификаты Let’s Encrypt)
3. `coturn` (TURN/STUN для WebRTC звонков)
- TURN и WebRTC настраиваются через `.env`, без редактирования JSON.
- Есть опция авто-определения внешнего IP для dynamic IP сценариев.

## Быстрый запуск на сервере (рекомендуется)

1. Подготовьте сервер:
   - Docker + Docker Compose
   - домен, направленный на сервер (A-запись)
2. Скопируйте переменные:

```bash
cp .env.example .env
```

3. Отредактируйте минимум эти значения в `.env`:
   - `APP_DOMAIN=your-domain.com`
   - `ACME_EMAIL=you@example.com`
   - `SECRET_KEY=...` (32+ символа)
   - `JWT_SECRET_KEY=...` (32+ символа)
   - `WEBRTC_TURN_CREDENTIAL=...` (сильный пароль)
   - `SOCKETIO_ASYNC_MODE=threading`
4. Откройте порты на сервере/фаерволе:
   - `80/tcp`
   - `443/tcp`
   - `443/udp`
   - `${TURN_LISTEN_PORT}` (по умолчанию `3478`) `tcp/udp`
   - `${TURN_MIN_PORT}-${TURN_MAX_PORT}` (по умолчанию `49160-49200`) `tcp/udp`
5. Запустите:

```bash
docker compose up -d --build
```

6. Проверьте:
   - сайт: `https://your-domain.com`
   - health: `https://your-domain.com/health`

## Где настраивать TURN

Все настройки находятся в `.env`:

- Клиентский ICE:
  - `WEBRTC_TURN_URLS`
  - `WEBRTC_TURN_USERNAME`
  - `WEBRTC_TURN_CREDENTIAL`
- Контейнер coturn:
  - `TURN_REALM`
  - `TURN_LISTEN_PORT`
  - `TURN_MIN_PORT`
  - `TURN_MAX_PORT`
  - `TURN_EXTERNAL_IP`
  - `TURN_DETECT_EXTERNAL_IP`

По умолчанию `WEBRTC_TURN_URLS` уже формируется от `APP_DOMAIN` и сразу готов к работе.

## Dynamic IP: как использовать

Если IP меняется, рабочая схема такая:

1. Используйте DDNS-домен (Cloudflare, DuckDNS, No-IP и т.д.).
2. Держите `APP_DOMAIN` равным DDNS-домену.
3. Включите авто-определение внешнего IP:

```env
TURN_DETECT_EXTERNAL_IP=1
```

4. Если автоопределение не подходит, задайте вручную:

```env
TURN_EXTERNAL_IP=203.0.113.10
```

## Если хотите использовать внешний TURN (например ExpressTURN)

Просто замените в `.env`:

```env
WEBRTC_TURN_URLS=turn:free.expressturn.com:3478?transport=udp,turn:free.expressturn.com:3478?transport=tcp
WEBRTC_TURN_USERNAME=YOUR_USERNAME
WEBRTC_TURN_CREDENTIAL=YOUR_PASSWORD
```

Локальный `coturn` можно оставить как fallback, либо убрать сервис `coturn` из `docker-compose.yml`.

## Почему на мобильном может писать «браузер не поддерживается»

Чаще всего причина не в браузере, а в окружении:

1. Сайт открыт по `http`, а не по `https`.
2. Нет доступа к микрофону/камере.
3. Нет рабочего TURN (в строгих NAT/мобильных сетях).

## Локальный dev-запуск

```bash
docker compose up --build
```

Для локалки можно использовать `APP_DOMAIN=localhost`, но для звонков на реальных устройствах лучше полноценный HTTPS-домен.

## Полезные команды

```bash
docker compose ps
docker compose logs -f messenger
docker compose logs -f caddy
docker compose logs -f coturn
docker compose restart
```

## Если `/health` даёт `Connection reset by peer`

1. Убедитесь, что в `.env`:

```env
SOCKETIO_ASYNC_MODE=threading
SOCKETIO_FORCE_EVENTLET=0
```

2. Пересоберите `messenger`:

```bash
docker compose down
docker compose up -d --build --force-recreate messenger
docker compose logs --tail=120 messenger
curl -v http://127.0.0.1:5000/health
```

## Cloudflared (Tunnel)

Для сценария с Cloudflare Tunnel не нужно править `docker-compose.yml` вручную:

1. Поднимите только приложение:

```bash
docker compose up -d --build messenger
```

2. Проверьте локальный endpoint:

```bash
curl http://127.0.0.1:5000/health
```

`messenger` уже публикуется как `127.0.0.1:5000->5000/tcp`, поэтому `cloudflared` можно направлять на `http://127.0.0.1:5000`.

## Примечания по безопасности

- Обязательно смените все секреты из `.env.example`.
- `JWT_SECRET_KEY` короче 32 байт вызывает предупреждения безопасности.
- Не публикуйте реальный `.env` в репозиторий.

## Runtime profile in Docker

By default the container now starts with Gunicorn (`gthread`) via `start.sh`.
This avoids relying on Werkzeug in production and improves stability for `/health` and Socket.IO.

Env knobs:
- `APP_SERVER=gunicorn` (default) or `APP_SERVER=python`
- `GUNICORN_WORKERS=1`
- `GUNICORN_THREADS=100`
- `GUNICORN_TIMEOUT=120`

If you need old behavior for debugging, set `APP_SERVER=python`.

## Image preview thumbnails

Image attachments now render lightweight WebP previews in chat, while opening the original file on click.

Env knobs:
- `IMAGE_PREVIEW_MAX_SIDE=720` (max width/height of generated preview)
- `IMAGE_PREVIEW_WEBP_QUALITY=68` (WebP quality for preview)

Apply changes:

```bash
docker compose up -d --build messenger
```
