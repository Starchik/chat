(function () {
    if (!("serviceWorker" in navigator)) {
        return;
    }

    const SW_VERSION = window.APP_CONFIG?.cacheVersion || "v1";
    const SW_VERSION_KEY = "messenger_sw_version";
    const SW_URL = `/static/sw.js?v=${encodeURIComponent(SW_VERSION)}`;

    async function clearServiceWorkerState() {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
        } catch (error) {
            console.warn("Service worker cleanup failed", error);
        }

        if (!("caches" in window)) {
            return;
        }

        try {
            const keys = await caches.keys();
            await Promise.all(keys.map((key) => caches.delete(key)));
        } catch (error) {
            console.warn("Cache cleanup failed", error);
        }
    }

    async function ensureFreshVersion() {
        const previousVersion = localStorage.getItem(SW_VERSION_KEY);
        if (previousVersion === SW_VERSION) {
            return false;
        }

        localStorage.setItem(SW_VERSION_KEY, SW_VERSION);
        await clearServiceWorkerState();
        return true;
    }

    async function registerServiceWorker() {
        try {
            const shouldReload = await ensureFreshVersion();
            if (shouldReload) {
                window.location.reload();
                return;
            }

            const registration = await navigator.serviceWorker.register(SW_URL, {
                updateViaCache: "none",
            });
            await registration.update();

            if (registration.waiting) {
                registration.waiting.postMessage({ type: "SKIP_WAITING" });
            }

            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (window.__swControllerReloaded) {
                    return;
                }
                window.__swControllerReloaded = true;
                window.location.reload();
            });

            await subscribePush(registration);
        } catch (error) {
            console.warn("Service worker registration failed", error);
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i += 1) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function subscribePush(registration) {
        if (!("PushManager" in window) || !("Notification" in window)) {
            return;
        }

        if (Notification.permission === "denied") {
            return;
        }

        try {
            const { public_key: publicKey } = await window.Api.getPushPublicKey();
            if (!publicKey) {
                return;
            }

            let permission = Notification.permission;
            if (permission !== "granted") {
                permission = await Notification.requestPermission();
            }
            if (permission !== "granted") {
                return;
            }

            const existing = await registration.pushManager.getSubscription();
            const subscription = existing || await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });

            await window.Api.subscribePush(subscription.toJSON());
        } catch (error) {
            console.warn("Push subscription failed", error);
        }
    }

    registerServiceWorker();
})();
