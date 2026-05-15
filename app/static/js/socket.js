export function initSocketModule(app) {
    const { refs, state, helpers, config } = app;

    const deps = {
        chats: null,
        messages: null,
        calls: null,
    };

    let socket = null;
    let presenceTimer = null;
    let warnedConnectionFailure = false;
    let connectionIssueTimer = null;

    const CONNECTION_ISSUE_TOAST_DELAY_MS = 7000;
    const MIN_FAILURES_BEFORE_TOAST = 2;
    let connectErrorCount = 0;

    function clearConnectionIssueTimer() {
        if (connectionIssueTimer) {
            window.clearTimeout(connectionIssueTimer);
            connectionIssueTimer = null;
        }
    }

    function shouldSuppressConnectionToast() {
        if (document.hidden) {
            return true;
        }

        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            return true;
        }

        return false;
    }

    function scheduleConnectionIssueToast() {
        if (warnedConnectionFailure) {
            return;
        }

        if (connectErrorCount < MIN_FAILURES_BEFORE_TOAST) {
            return;
        }

        if (shouldSuppressConnectionToast()) {
            return;
        }

        if (connectionIssueTimer) {
            return;
        }

        connectionIssueTimer = window.setTimeout(() => {
            connectionIssueTimer = null;

            if (!socket || socket.connected) {
                return;
            }

            if (shouldSuppressConnectionToast()) {
                return;
            }

            warnedConnectionFailure = true;
            helpers.showToast("Проблема с realtime-соединением");
        }, CONNECTION_ISSUE_TOAST_DELAY_MS);
    }

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
        if (typeof payload === "undefined") {
            socket.emit(eventName);
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
            connectErrorCount = 0;
            warnedConnectionFailure = false;
            clearConnectionIssueTimer();
            emitSafe("presence_ping");
            startPresenceTimer();

            if (state.currentChatId) {
                emitSafe("join_chat", { chat_id: state.currentChatId });
            }
        });

        socket.on("disconnect", () => {
            clearPresenceTimer();
            scheduleConnectionIssueToast();
        });

        socket.on("connect_error", (error) => {
            console.warn("socket connect error", error?.message || error);
            connectErrorCount += 1;
            scheduleConnectionIssueToast();
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

        socket.on("chat_history_cleared", (payload) => {
            deps.chats?.onChatHistoryCleared(payload || {});
        });

        socket.on("chat_deleted", (payload) => {
            deps.chats?.onChatDeleted(payload || {});
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

        socket.on("call_invite", (payload) => {
            deps.calls?.onSocketCallInvite(payload || {});
        });

        socket.on("call_accept", (payload) => {
            deps.calls?.onSocketCallAccept(payload || {});
        });

        socket.on("call_reject", (payload) => {
            deps.calls?.onSocketCallReject(payload || {});
        });

        socket.on("call_end", (payload) => {
            deps.calls?.onSocketCallEnd(payload || {});
        });

        socket.on("call_signal", (payload) => {
            deps.calls?.onSocketCallSignal(payload || {});
        });

        socket.on("call_error", (payload) => {
            deps.calls?.onSocketCallError(payload || {});
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

    function callInvite(payload) {
        emitSafe("call_invite", payload);
    }

    function callAccept(payload) {
        emitSafe("call_accept", payload);
    }

    function callReject(payload) {
        emitSafe("call_reject", payload);
    }

    function callEnd(payload) {
        emitSafe("call_end", payload);
    }

    function callSignal(payload) {
        emitSafe("call_signal", payload);
    }

    function attachDependencies(nextDeps) {
        deps.chats = nextDeps.chats;
        deps.messages = nextDeps.messages;
        deps.calls = nextDeps.calls;
    }

    return {
        attachDependencies,
        connect,
        joinChat,
        leaveChat,
        sendTyping,
        readMessages,
        isConnected,
        callInvite,
        callAccept,
        callReject,
        callEnd,
        callSignal,
    };
}
