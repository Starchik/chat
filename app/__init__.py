from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from dotenv import load_dotenv
from flask import Flask, render_template, request, url_for

from app.api import register_api
from app.config import Config
from app.extensions import db, init_extensions
from app.sockets import register_sockets
from app.utils import b64url_encode, ensure_directories


def _ensure_vapid_keys(app):
    private_key_path = Path(app.config["VAPID_PRIVATE_KEY_PATH"])
    public_key_path = Path(app.config["VAPID_PUBLIC_KEY_PATH"])

    if private_key_path.exists() and public_key_path.exists():
        app.config["VAPID_PUBLIC_KEY"] = public_key_path.read_text(encoding="utf-8").strip()
        return

    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    public_key_path.parent.mkdir(parents=True, exist_ok=True)

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key().public_numbers()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    private_key_path.write_bytes(private_pem)

    public_key_bytes = b"\x04" + public_key.x.to_bytes(32, "big") + public_key.y.to_bytes(32, "big")
    public_key_b64 = b64url_encode(public_key_bytes)
    public_key_path.write_text(public_key_b64, encoding="utf-8")

    app.config["VAPID_PUBLIC_KEY"] = public_key_b64


def create_app():
    load_dotenv()

    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)

    ensure_directories(
        [
            app.config["INSTANCE_DIR"],
            app.config["UPLOAD_BASE_FOLDER"],
            app.config["AVATAR_UPLOAD_FOLDER"],
            app.config["FILE_UPLOAD_FOLDER"],
        ]
    )

    _ensure_vapid_keys(app)
    init_extensions(app)
    register_api(app)
    register_sockets()

    with app.app_context():
        db.create_all()

    def asset_url(filename: str) -> str:
        static_root = Path(app.static_folder or "")
        try:
            version = int((static_root / filename).stat().st_mtime)
        except OSError:
            version = 0
        return url_for("static", filename=filename, v=version)

    app.jinja_env.globals["asset_url"] = asset_url

    @app.get("/")
    def index():
        return render_template("chat.html")

    @app.get("/login")
    def login_page():
        return render_template("login.html")

    @app.get("/register")
    def register_page():
        return render_template("register.html")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.after_request
    def add_cache_headers(response):
        path = request.path or ""

        if response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        if path == "/static/sw.js":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        return response

    return app
