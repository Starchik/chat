window.APP_CONFIG = {
    apiBase: "/api",
    socketPath: "/socket.io",
    cacheVersion: "v31",
    messagePageSize: 30,
    maxCachedMessages: 500,
    maxUploadFiles: 100,
    uploadChunkSize: Math.max(64 * 1024, Number(window.APP_RUNTIME?.upload_chunk_size) || (1024 * 1024)),
    webrtcIceServers: Array.isArray(window.APP_RUNTIME?.webrtc_ice_servers)
        ? window.APP_RUNTIME.webrtc_ice_servers
        : [{ urls: "stun:stun.l.google.com:19302" }],
    webrtcRingTimeoutSec: Number(window.APP_RUNTIME?.webrtc_ring_timeout_sec) || 45,
    webrtcRingtoneIncomingUrl: String(window.APP_RUNTIME?.webrtc_ringtone_incoming_url || "/static/sounds/ring-incoming.wav"),
    webrtcRingtoneOutgoingUrl: String(window.APP_RUNTIME?.webrtc_ringtone_outgoing_url || "/static/sounds/ring-outgoing.wav"),
    webrtcRingtoneIncomingVolume: Math.max(0, Math.min(1, Number(window.APP_RUNTIME?.webrtc_ringtone_incoming_volume ?? 0.88))),
    webrtcRingtoneOutgoingVolume: Math.max(0, Math.min(1, Number(window.APP_RUNTIME?.webrtc_ringtone_outgoing_volume ?? 0.72))),
    emojiList: [
        "😀", "😁", "😂", "🤣", "😅", "😊", "😍", "😘",
        "😎", "🥹", "🤔", "😴", "😡", "😭", "😇", "🤝",
        "👍", "🙏", "👏", "🔥", "💯", "🎉", "❤️", "💙",
        "💚", "🧡", "💜", "🤍", "🖤", "💬", "✨", "🫶",
    ],
};

