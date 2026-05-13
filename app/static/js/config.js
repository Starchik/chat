window.APP_CONFIG = {
    apiBase: "/api",
    socketPath: "/socket.io",
    cacheVersion: "v6",
    messagePageSize: 30,
    maxCachedMessages: 500,
    maxUploadFiles: 10,
    webrtcIceServers: Array.isArray(window.APP_RUNTIME?.webrtc_ice_servers)
        ? window.APP_RUNTIME.webrtc_ice_servers
        : [{ urls: "stun:stun.l.google.com:19302" }],
    webrtcRingTimeoutSec: Number(window.APP_RUNTIME?.webrtc_ring_timeout_sec) || 45,
    emojiList: [
        "😀", "😁", "😂", "🤣", "😅", "😊", "😍", "😘",
        "😎", "🥹", "🤔", "😴", "😡", "😭", "😇", "🤝",
        "👍", "🙏", "👏", "🔥", "💯", "🎉", "❤️", "💙",
        "💚", "🧡", "💜", "🤍", "🖤", "💬", "✨", "🫶",
    ],
};
