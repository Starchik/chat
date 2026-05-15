import json
import time
from pathlib import Path

from flask import current_app


def cleanup_stale_chunk_uploads(app=None) -> int:
    target_app = app or current_app
    base_folder = Path(target_app.config["CHUNK_UPLOAD_FOLDER"])
    ttl_sec = max(300, int(target_app.config.get("CHUNK_UPLOAD_TTL_SEC", 7200)))
    now = int(time.time())
    removed_files = 0

    if not base_folder.exists():
        return 0

    for meta_path in base_folder.glob("*.json"):
        stale = False
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            updated_at = int(meta.get("updated_at") or meta.get("created_at") or 0)
            stale = updated_at <= 0 or (now - updated_at) > ttl_sec
        except Exception:
            stale = True

        if not stale:
            continue

        upload_id = meta_path.stem
        part_path = base_folder / f"{upload_id}.part"

        for path in (meta_path, part_path):
            try:
                path.unlink()
                removed_files += 1
            except FileNotFoundError:
                pass

    for part_path in base_folder.glob("*.part"):
        upload_id = part_path.stem
        if (base_folder / f"{upload_id}.json").exists():
            continue

        age_sec = now - int(part_path.stat().st_mtime)
        if age_sec <= ttl_sec:
            continue

        try:
            part_path.unlink()
            removed_files += 1
        except FileNotFoundError:
            pass

    return removed_files
