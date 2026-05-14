#!/usr/bin/env sh
set -e

mkdir -p /app/instance
mkdir -p /app/app/static/uploads/avatars
mkdir -p /app/app/static/uploads/files

python run.py
