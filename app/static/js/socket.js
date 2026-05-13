export function initSocketModule(app) {
    const { refs, state, helpers, config } = app;

    const deps = {
        chats: null,
        messages: null,
    };

    let socket = null;
    let presenceTimer = null;
    let warnedConnectionFailure = false;

    function clearPresenceTimer() {
        if (presenceTimer) {
            window.clearInterval(presenceTimer);
            presenceTimer = null;
        }
    }

    function startPresenceTimer() {
        clearPresenceTimer();
        presenceTimer = window.setInterval(() => {
            if (socket?.connected) {
                socket.emit("presence_ping");
            }
        }, 25000);
    }

    function emitSafe(eventName, payload) {
        if (!socket || !socket.connected) {
            return;
        }
        socket.emit(eventName, payload);
    }

    function connect() {
        if (typeof io === "undefined") {
            helpers.showToast("Realtime недоступен: Socket.IO не загружен");
            return;
        }

        socket = io({
            path: config.socketPath || "/socket.io",
            auth: {
                token: state.token,
            },
            transports: ["websocket", "polling"],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 700,
            reconnectionDelayMax: 4000,
        });

        socket.on("connect", () => {
            warnedConnectionFailure = false;
            emitSafe("presence_ping");
            startPresenceTimer();

            if (state.currentChatId) {
                emitSafe("join_chat", { chat_id: state.currentChatId });
            }
        });

        socket.on("disconnect", () => {
            clearPresenceTimer();
        });

        socket.on("connect_error", (error) => {
            console.warn("socket connect error", error?.message || error);
            if (!warnedConnectionFailure) {
                warnedConnectionFailure = true;
                helpers.showToast("Проблема с realtime-соединением");
            }
        });

        socket.on("new_message", (payload) => {
            if (payload?.message) {
                deps.messages.onIncomingMessage(payload.message);
            }
        });

        socket.on("message_updated", (payload) => {
            if (payload?.message) {
                deps.messages.onMessageUpdated(payload.message);
            }
        });

        socket.on("message_deleted", (payload) => {
            deps.messages.onMessageDeleted(payload || {});
        });

        socket.on("message_pinned", (payload) => {
            deps.messages.onMessagePinned(payload || {});
        });

        socket.on("message_unpinned", (payload) => {
            deps.messages.onMessageUnpinned(payload || {});
        });

        socket.on("messages_read", (payload) => {
            deps.messages.onMessagesRead(payload || {});
        });

        socket.on("typing", (payload) => {
            deps.messages.onTypingPayload(payload || {});
        });

        socket.on("chat_updated", (payload) => {
            if (payload?.chat) {
                deps.chats.applyChatPayload(payload.chat);
            }
        });

        socket.on("user_status", (payload) => {
            if (!payload?.user_id) {
                return;
            }
            deps.chats.updateUserPresence(payload.user_id, Boolean(payload.is_online));
        });

        socket.on("error", (payload) => {
            if (payload?.error) {
                console.warn("socket event error", payload.error);
            }
        });
    }

    function joinChat(chatId) {
        emitSafe("join_chat", { chat_id: Number(chatId) });
    }

    function leaveChat(chatId) {
        emitSafe("leave_chat", { chat_id: Number(chatId) });
    }

    function sendTyping(chatId, isTyping) {
        emitSafe("typing", {
            chat_id: Number(chatId),
            is_typing: Boolean(isTyping),
        });
    }

    function readMessages(chatId, messageId) {
        emitSafe("read_messages", {
            chat_id: Number(chatId),
            message_id: messageId || null,
        });
    }

    function isConnected() {
        return Boolean(socket?.connected);
    }

    function attachDependencies(nextDeps) {
        deps.chats = nextDeps.chats;
        deps.messages = nextDeps.messages;
    }

    return {
        attachDependencies,
        connect,
        joinChat,
        leaveChat,
        sendTyping,
        readMessages,
        isConnected,
    };
}
