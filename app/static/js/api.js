(function (global) {
    const API_BASE = window.APP_CONFIG.apiBase;
    const DEFAULT_UPLOAD_CHUNK_SIZE = Math.max(
        64 * 1024,
        Number(window.APP_CONFIG.uploadChunkSize) || (1024 * 1024),
    );

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

    async function initChunkUpload({ chatId, file }) {
        return apiRequest("/messages/uploads/init", {
            method: "POST",
            body: JSON.stringify({
                chat_id: chatId,
                file_name: file.name,
                file_size: file.size,
                mime_type: file.type || "application/octet-stream",
            }),
        });
    }

    async function uploadFileInChunks({ chatId, file, fileIndex = 0, fileCount = 1, onProgress = null }) {
        const initPayload = await initChunkUpload({ chatId, file });
        const uploadId = String(initPayload.upload_id || "").trim();
        const chunkSize = Math.max(
            64 * 1024,
            Number(initPayload.chunk_size) || DEFAULT_UPLOAD_CHUNK_SIZE,
        );
        const totalChunks = Math.max(
            1,
            Number(initPayload.total_chunks) || Math.ceil(file.size / chunkSize),
        );

        if (!uploadId) {
            throw new Error("Сервер не вернул upload_id");
        }

        if (typeof onProgress === "function") {
            onProgress({
                file,
                fileIndex,
                fileCount,
                uploadedBytes: 0,
                totalBytes: file.size,
                percent: 0,
            });
        }

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
            const start = chunkIndex * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunkBlob = file.slice(start, end);

            const formData = new FormData();
            formData.append("upload_id", uploadId);
            formData.append("chunk_index", String(chunkIndex));
            formData.append("chunk", chunkBlob, file.name);

            await apiRequest("/messages/uploads/chunk", {
                method: "POST",
                body: formData,
            });

            if (typeof onProgress === "function") {
                const uploadedBytes = end;
                const totalBytes = file.size;
                const percent = totalBytes > 0
                    ? Math.min(100, (uploadedBytes / totalBytes) * 100)
                    : 100;

                onProgress({
                    file,
                    fileIndex,
                    fileCount,
                    uploadedBytes,
                    totalBytes,
                    percent,
                });
            }
        }

        return uploadId;
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

        searchChatMessages(chatId, query, limit = 50) {
            const params = new URLSearchParams();
            params.set("q", String(query || ""));
            params.set("limit", String(limit));
            return apiRequest(`/chats/${chatId}/messages/search?${params.toString()}`, { method: "GET" });
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

        clearChatHistory(chatId) {
            return apiRequest(`/chats/${chatId}/history`, { method: "DELETE" });
        },

        deleteChat(chatId) {
            return apiRequest(`/chats/${chatId}`, { method: "DELETE" });
        },

        async sendMessage({
            chatId,
            content,
            replyToId = null,
            forwardFromId = null,
            files = [],
            onUploadProgress = null,
        }) {
            if (files.length > 0) {
                const uploadIds = [];

                for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
                    const file = files[fileIndex];
                    const uploadId = await uploadFileInChunks({
                        chatId,
                        file,
                        fileIndex,
                        fileCount: files.length,
                        onProgress: onUploadProgress,
                    });
                    uploadIds.push(uploadId);
                }

                return apiRequest("/messages", {
                    method: "POST",
                    body: JSON.stringify({
                        chat_id: chatId,
                        content,
                        reply_to_id: replyToId,
                        forwarded_from_message_id: forwardFromId,
                        upload_ids: uploadIds,
                    }),
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
