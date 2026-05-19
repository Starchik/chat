from flask import Blueprint, current_app, jsonify
from flask_jwt_extended import jwt_required


system_bp = Blueprint("system", __name__, url_prefix="/system")


@system_bp.get("/runtime")
@jwt_required()
def runtime_config():
    return jsonify(
        {
            "webrtc_ice_servers": current_app.config.get("WEBRTC_ICE_SERVERS", []),
            "webrtc_ring_timeout_sec": int(current_app.config.get("WEBRTC_RING_TIMEOUT_SEC", 45)),
        }
    )

