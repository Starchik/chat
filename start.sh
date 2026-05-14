#!/usr/bin/env sh
set -e

mkdir -p /app/instance
mkdir -p /app/app/static/uploads/avatars
mkdir -p /app/app/static/uploads/files

APP_SERVER="${APP_SERVER:-gunicorn}"
PORT="${PORT:-5000}"

if [ "$APP_SERVER" = "python" ]; then
  exec python run.py
fi

GUNICORN_WORKERS="${GUNICORN_WORKERS:-1}"
GUNICORN_THREADS="${GUNICORN_THREADS:-100}"
GUNICORN_TIMEOUT="${GUNICORN_TIMEOUT:-120}"

exec gunicorn \
  --worker-class gthread \
  --workers "$GUNICORN_WORKERS" \
  --threads "$GUNICORN_THREADS" \
  --timeout "$GUNICORN_TIMEOUT" \
  --bind "0.0.0.0:${PORT}" \
  --access-logfile - \
  --error-logfile - \
  "run:app"
