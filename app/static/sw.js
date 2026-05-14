const SW_VERSION = new URL(self.location.href).searchParams.get("v") || "v1";
const CACHE_NAME = `messenger-static-${SW_VERSION}`;
const OFFLINE_URLS = [
    "/",
    "/login",
    "/register",
    "/static/css/variables.css",
    "/static/css/components.css",
    "/static/css/layout.css",
    "/static/css/sidebar.css",
    "/static/css/chat.css",
    "/static/css/responsive.css",
    "/static/js/config.js",
    "/static/js/api.js",
    "/static/js/storage.js",
    "/static/js/auth.js",
    "/static/js/socket.io.min.js",
    "/static/js/ui.js",
    "/static/js/chats.js",
    "/static/js/messages.js",
    "/static/js/uploads.js",
    "/static/js/calls.js",
    "/static/js/socket.js",
    "/static/js/sw-register.js",
    "/static/sounds/ring-incoming2.wav",
    "/static/sounds/ring-outgoing.wav",
    "/static/manifest.json",
    "/static/icons/icon-192.svg",
    "/static/icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS)),
    );
    self.skipWaiting();
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys
                .filter((key) => key !== CACHE_NAME)
                .map((key) => caches.delete(key)),
        )),
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (url.pathname.startsWith("/api/")) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
    );
});

self.addEventListener("push", (event) => {
    const fallback = {
        title: "\u041d\u043e\u0432\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435",
        body: "\u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u0447\u0430\u0442, \u0447\u0442\u043e\u0431\u044b \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435",
        chat_id: null,
    };

    let data = { ...fallback };

    if (event.data) {
        try {
            const payload = event.data.json();
            data = {
                title: payload?.title || fallback.title,
                body: payload?.body || fallback.body,
                chat_id: payload?.chat_id ?? null,
            };
        } catch (_error) {
            const plainBody = event.data.text();
            data = {
                title: fallback.title,
                body: plainBody || fallback.body,
                chat_id: null,
            };
        }
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: "/static/icons/icon-192.svg",
            badge: "/static/icons/icon-192.svg",
            data: { chatId: data.chat_id || null },
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const chatId = event.notification.data?.chatId;

    event.waitUntil((async () => {
        const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });

        if (allClients.length > 0) {
            const client = allClients[0];
            client.focus();
            if (chatId) {
                client.postMessage({ type: "OPEN_CHAT", chatId });
            }
            return;
        }

        const targetUrl = chatId ? `/?chat=${chatId}` : "/";
        await clients.openWindow(targetUrl);
    })());
});
