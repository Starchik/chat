(function (global) {
    const API_BASE = window.APP_CONFIG.apiBase;

    async function apiRequest(path, options = {}) {
        const token = global.AppStorage.getToken();
        const headers = new Headers(options.headers || {});

        if (!(options.body instanceof FormData)) {
            headers.set("Content-Type", "application/json");
        }
        if (token) {
            headers.set("Authorization", `Bearer ${token}`);
        }

        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
        });

        let payload = {};
        try {
            payload = await response.json();
        } catch (error) {
            payload = {};
        }

        if (!response.ok) {
            const message = payload.error || `HTTP ${response.status}`;
            throw new Error(message);
        }

        return payload;
    }

    const Api = {
        register(data) {
            return apiRequest("/auth/register", {
                method: "POST",
                body: JSON.stringify(data),
            });
        },

        login(data) {
            return apiRequest("/auth/login", {
                method: "POST",
                body: JSON.stringify(data),
            });
        },

        me() {
            return apiRequest("/auth/me", { method: "GET" });
        },

        uploadAvatar(file) {
            const formData = new FormData();
            formData.append("avatar", file);
            return apiRequest("/auth/avatar", {
                method: "POST",
                body: formData,
            });
        },

        searchUsers(query) {
            return apiRequest(`/users/search?q=${encodeURIComponent(query)}`, { method: "GET" });
        },

        listChats(includeArchived = false) {
            return apiRequest(`/chats?archived=${includeArchived ? "true" : "false"}`, { method: "GET" });
        },

        getChat(chatId) {
            return apiRequest(`/chats/${chatId}`, { method: "GET" });
        },

        createPrivateChat(targetUserId) {
            return apiRequest("/chats", {
                method: "POST",
                body: JSON.stringify({ type: "private", target_user_id: targetUserId }),
            });
        },

        createGroupChat(payload) {
            return apiRequest("/chats", {
                method: "POST",
                body: JSON.stringify({ ...payload, type: "group" }),
            });
        },

        getMessages(chatId, before = null, limit = 30) {
            const params = new URLSearchParams();
            params.set("limit", String(limit));
            if (before) {
                params.set("before", String(before));
            }
            return apiRequest(`/chats/${chatId}/messages?${params.toString()}`, { method: "GET" });
        },

        markChatRead(chatId, messageId = null) {
            return apiRequest(`/chats/${chatId}/read`, {
                method: "POST",
                body: JSON.stringify({ message_id: messageId }),
            });
        },

        archiveChat(chatId, archive = true) {
            return apiRequest(`/chats/${chatId}/archive`, {
                method: "PATCH",
                body: JSON.stringify({ archive }),
            });
        },

        async sendMessage({ chatId, content, replyToId = null, forwardFromId = null, files = [] }) {
            if (files.length > 0) {
                const formData = new FormData();
                formData.append("chat_id", String(chatId));
                if (content) {
                    formData.append("content", content);
                }
                if (replyToId) {
                    formData.append("reply_to_id", String(replyToId));
                }
                if (forwardFromId) {
                    formData.append("forwarded_from_message_id", String(forwardFromId));
                }
                files.forEach((file) => {
                    formData.append("files", file);
                });

                return apiRequest("/messages", {
                    method: "POST",
                    body: formData,
                });
            }

            return apiRequest("/messages", {
                method: "POST",
                body: JSON.stringify({
                    chat_id: chatId,
                    content,
                    reply_to_id: replyToId,
                    forwarded_from_message_id: forwardFromId,
                }),
            });
        },

        editMessage(messageId, content) {
            return apiRequest(`/messages/${messageId}`, {
                method: "PUT",
                body: JSON.stringify({ content }),
            });
        },

        deleteMessage(messageId) {
            return apiRequest(`/messages/${messageId}`, { method: "DELETE" });
        },

        forwardMessage(messageId, targetChatId) {
            return apiRequest(`/messages/${messageId}/forward`, {
                method: "POST",
                body: JSON.stringify({ target_chat_id: targetChatId }),
            });
        },

        pinMessage(messageId) {
            return apiRequest(`/messages/${messageId}/pin`, { method: "POST" });
        },

        unpinMessage(messageId) {
            return apiRequest(`/messages/${messageId}/pin`, { method: "DELETE" });
        },

        getPushPublicKey() {
            return apiRequest("/push/public-key", { method: "GET" });
        },

        subscribePush(subscription) {
            return apiRequest("/push/subscribe", {
                method: "POST",
                body: JSON.stringify(subscription),
            });
        },

        unsubscribePush(endpoint) {
            return apiRequest("/push/unsubscribe", {
                method: "POST",
                body: JSON.stringify({ endpoint }),
            });
        },
    };

    global.Api = Api;
})(window);
