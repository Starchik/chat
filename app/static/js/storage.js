(function (global) {
    const CACHE_VERSION = (global.APP_CONFIG && global.APP_CONFIG.cacheVersion) || "v1";
    const KEY_TOKEN = "messenger_token";
    const KEY_USER = "messenger_user";
    const KEY_CHATS = `messenger_chats_${CACHE_VERSION}`;
    const KEY_MESSAGES_PREFIX = `messenger_messages_${CACHE_VERSION}_`;

    function safeJsonParse(value, fallback) {
        try {
            return JSON.parse(value);
        } catch (error) {
            return fallback;
        }
    }

    const AppStorage = {
        getToken() {
            return localStorage.getItem(KEY_TOKEN);
        },

        setToken(token) {
            localStorage.setItem(KEY_TOKEN, token);
        },

        getUser() {
            return safeJsonParse(localStorage.getItem(KEY_USER), null);
        },

        setUser(user) {
            localStorage.setItem(KEY_USER, JSON.stringify(user));
        },

        clearAuth() {
            localStorage.removeItem(KEY_TOKEN);
            localStorage.removeItem(KEY_USER);
        },

        getChats() {
            return safeJsonParse(localStorage.getItem(KEY_CHATS), []);
        },

        setChats(chats) {
            localStorage.setItem(KEY_CHATS, JSON.stringify(chats));
        },

        getMessages(chatId) {
            return safeJsonParse(localStorage.getItem(`${KEY_MESSAGES_PREFIX}${chatId}`), []);
        },

        setMessages(chatId, messages) {
            localStorage.setItem(`${KEY_MESSAGES_PREFIX}${chatId}`, JSON.stringify(messages));
        },

        appendMessage(chatId, message) {
            const messages = this.getMessages(chatId);
            messages.push(message);
            this.setMessages(chatId, messages.slice(-300));
        },

        updateMessage(chatId, updatedMessage) {
            const messages = this.getMessages(chatId);
            const next = messages.map((message) => (
                message.id === updatedMessage.id ? updatedMessage : message
            ));
            this.setMessages(chatId, next);
        },

        removeMessage(chatId, messageId) {
            const messages = this.getMessages(chatId);
            const next = messages.map((message) => {
                if (message.id !== messageId) {
                    return message;
                }
                return {
                    ...message,
                    is_deleted: true,
                    content: null,
                };
            });
            this.setMessages(chatId, next);
        },

        clearChatCache(chatId) {
            localStorage.removeItem(`${KEY_MESSAGES_PREFIX}${chatId}`);
        },
    };

    global.AppStorage = AppStorage;
})(window);
