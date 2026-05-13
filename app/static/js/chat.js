(function () {
    const token = window.AppStorage.getToken();
    if (!token) {
        window.location.href = "/login";
        return;
    }

    const state = {
        me: null,
        chats: [],
        currentChatId: null,
        selectedFiles: [],
        replyToMessage: null,
        editMessageId: null,
        typingTimer: null,
        typingUsersByChat: new Map(),
        hasMoreByChat: {},
        loadingMoreByChat: {},
        socket: null,
    };

    const els = {
        appShell: document.getElementById("app-shell"),
        meAvatar: document.getElementById("me-avatar"),
        meName: document.getElementById("me-name"),
        meUsername: document.getElementById("me-username"),
        avatarInput: document.getElementById("avatar-input"),
        logoutBtn: document.getElementById("logout-btn"),
        themeToggle: document.getElementById("theme-toggle"),
        userSearch: document.getElementById("user-search"),
        searchResults: document.getElementById("search-results"),
        newPrivateChatBtn: document.getElementById("new-private-chat-btn"),
        newGroupChatBtn: document.getElementById("new-group-chat-btn"),
        chatList: document.getElementById("chat-list"),
        chatAvatar: document.getElementById("chat-avatar"),
        chatTitle: document.getElementById("chat-title"),
        chatSubtitle: document.getElementById("chat-subtitle"),
        archiveChatBtn: document.getElementById("archive-chat-btn"),
        pinnedWrapper: document.getElementById("pinned-wrapper"),
        messagesScroll: document.getElementById("messages-scroll"),
        messagesList: document.getElementById("messages-list"),
        typingIndicator: document.getElementById("typing-indicator"),
        replyPreview: document.getElementById("reply-preview"),
        messageInput: document.getElementById("message-input"),
        attachBtn: document.getElementById("attach-btn"),
        fileInput: document.getElementById("file-input"),
        sendBtn: document.getElementById("send-btn"),
        emojiBtn: document.getElementById("emoji-btn"),
        emojiPanel: document.getElementById("emoji-panel"),
        contextMenu: document.getElementById("context-menu"),
        modalOverlay: document.getElementById("modal-overlay"),
        modal: document.getElementById("modal"),
        toast: document.getElementById("toast"),
    };

    function showToast(text) {
        els.toast.textContent = text;
        els.toast.classList.remove("hidden");
        setTimeout(() => {
            els.toast.classList.add("hidden");
        }, 2400);
    }

    function formatTime(isoString) {
        if (!isoString) {
            return "";
        }
        const date = new Date(isoString);
        return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }

    function formatChatTime(isoString) {
        if (!isoString) {
            return "";
        }
        const date = new Date(isoString);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) {
            return formatTime(isoString);
        }
        return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    }

    function escapeHtml(text) {
        if (!text) {
            return "";
        }
        return text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("\"", "&quot;")
            .replaceAll("'", "&#039;");
    }

    function sortChats() {
        state.chats.sort((a, b) => {
            const left = new Date(a.last_message_at || a.created_at || 0).getTime();
            const right = new Date(b.last_message_at || b.created_at || 0).getTime();
            return right - left;
        });
    }

    function getChatById(chatId) {
        return state.chats.find((chat) => chat.id === chatId);
    }

    function upsertChat(chat) {
        const index = state.chats.findIndex((item) => item.id === chat.id);
        if (index >= 0) {
            state.chats[index] = chat;
        } else {
            state.chats.push(chat);
        }
        sortChats();
        window.AppStorage.setChats(state.chats);
        renderChatList();
    }

    function renderMe() {
        if (!state.me) {
            return;
        }
        els.meAvatar.src = state.me.avatar_url || "https://placehold.co/80x80/28425A/FFFFFF?text=ME";
        els.meName.textContent = state.me.display_name;
        els.meUsername.textContent = `@${state.me.username}`;
    }

    function getChatPreview(chat) {
        if (!chat.last_message) {
            return "Нет сообщений";
        }
        if (chat.last_message.is_deleted) {
            return "Сообщение удалено";
        }
        if (chat.last_message.content) {
            return chat.last_message.content;
        }
        if (chat.last_message.attachments?.length) {
            return chat.last_message.attachments[0].kind === "image" ? "Фото" : "Файл";
        }
        return "Сообщение";
    }

    function renderChatList() {
        sortChats();
        els.chatList.innerHTML = "";

        state.chats.forEach((chat) => {
            const item = document.createElement("div");
            item.className = `chat-item ${state.currentChatId === chat.id ? "active" : ""}`;
            item.dataset.chatId = String(chat.id);

            const avatar = document.createElement("img");
            avatar.className = "avatar";
            avatar.src = chat.avatar_url || "https://placehold.co/80x80/35536f/FFFFFF?text=C";

            const meta = document.createElement("div");
            meta.className = "chat-item-meta";

            const title = document.createElement("div");
            title.className = "chat-item-title";
            title.textContent = chat.title || "Без названия";

            const last = document.createElement("div");
            last.className = "chat-item-last";
            last.textContent = getChatPreview(chat);

            meta.append(title, last);

            const extra = document.createElement("div");
            extra.className = "chat-item-extra";

            const time = document.createElement("div");
            time.className = "chat-time";
            time.textContent = formatChatTime(chat.last_message_at);

            extra.appendChild(time);

            if (chat.unread_count > 0) {
                const badge = document.createElement("div");
                badge.className = "badge";
                badge.textContent = String(chat.unread_count);
                extra.appendChild(badge);
            }

            item.append(avatar, meta, extra);
            item.addEventListener("click", () => openChat(chat.id));
            els.chatList.appendChild(item);
        });
    }

    function renderChatHeader(chat) {
        if (!chat) {
            els.chatAvatar.src = "https://placehold.co/80x80/35536f/FFFFFF?text=?";
            els.chatTitle.textContent = "Выберите чат";
            els.chatSubtitle.textContent = "Найдите пользователя или создайте чат";
            els.archiveChatBtn.disabled = true;
            els.pinnedWrapper.classList.add("hidden");
            return;
        }

        els.archiveChatBtn.disabled = false;
        els.chatAvatar.src = chat.avatar_url || "https://placehold.co/80x80/35536f/FFFFFF?text=C";
        els.chatTitle.textContent = chat.title;

        if (chat.is_group) {
            const onlineCount = (chat.members || []).filter((member) => member.is_online).length;
            els.chatSubtitle.textContent = `${chat.member_count} участников, онлайн: ${onlineCount}`;
        } else {
            els.chatSubtitle.textContent = chat.online ? "в сети" : "не в сети";
        }

        if (chat.pinned_message) {
            const pinned = chat.pinned_message;
            els.pinnedWrapper.classList.remove("hidden");
            els.pinnedWrapper.textContent = `Закреплено: ${pinned.content || "Вложение"}`;
        } else {
            els.pinnedWrapper.classList.add("hidden");
            els.pinnedWrapper.textContent = "";
        }
    }

    function getMessageFileHtml(attachment) {
        if (attachment.kind === "image") {
            return `<a href="${attachment.file_url}" target="_blank" class="message-file"><img src="${attachment.file_url}" alt="${escapeHtml(attachment.file_name)}" loading="lazy"></a>`;
        }
        return `<a href="${attachment.file_url}" target="_blank" class="message-file">📎 ${escapeHtml(attachment.file_name)}</a>`;
    }

    function renderMessage(message, { append = true } = {}) {
        const isMine = message.sender_id === state.me.id;
        const messageEl = document.createElement("article");
        messageEl.className = `message ${isMine ? "mine" : "other"} ${message.is_deleted ? "deleted" : ""}`;
        messageEl.dataset.messageId = String(message.id);

        const top = document.createElement("div");
        top.className = "message-top";

        const author = document.createElement("div");
        author.className = "message-author";
        author.textContent = message.sender?.display_name || "Unknown";
        top.appendChild(author);

        if (message.is_edited) {
            const edited = document.createElement("span");
            edited.textContent = "(изменено)";
            edited.style.fontSize = "11px";
            top.appendChild(edited);
        }

        messageEl.appendChild(top);

        if (message.reply_to) {
            const reply = document.createElement("div");
            reply.className = "message-reply";
            reply.textContent = message.reply_to.content || "Сообщение";
            messageEl.appendChild(reply);
        }

        if (message.forwarded_from_message_id) {
            const forwarded = document.createElement("div");
            forwarded.className = "message-reply";
            forwarded.textContent = "Пересланное сообщение";
            messageEl.appendChild(forwarded);
        }

        const content = document.createElement("div");
        content.className = "message-content";
        content.textContent = message.is_deleted ? "Сообщение удалено" : (message.content || "");
        messageEl.appendChild(content);

        if (message.attachments && message.attachments.length > 0) {
            const files = document.createElement("div");
            files.className = "message-files";
            files.innerHTML = message.attachments.map(getMessageFileHtml).join("");
            messageEl.appendChild(files);
        }

        const meta = document.createElement("div");
        meta.className = "message-meta";

        const date = document.createElement("span");
        date.textContent = formatTime(message.created_at);
        meta.appendChild(date);

        if (isMine && message.read_by && message.read_by.length > 1) {
            const read = document.createElement("span");
            read.textContent = "✓✓";
            meta.appendChild(read);
        }

        messageEl.appendChild(meta);

        messageEl.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            openContextMenu(event.clientX, event.clientY, message);
        });

        if (append) {
            els.messagesList.appendChild(messageEl);
        } else {
            els.messagesList.prepend(messageEl);
        }
    }

    function renderMessages(chatId) {
        const messages = window.AppStorage.getMessages(chatId);
        els.messagesList.innerHTML = "";
        messages.forEach((message) => renderMessage(message, { append: true }));
    }

    function scrollToBottom(smooth = false) {
        els.messagesScroll.scrollTo({
            top: els.messagesScroll.scrollHeight,
            behavior: smooth ? "smooth" : "auto",
        });
    }

    function mergeMessages(chatId, incomingMessages) {
        const existing = window.AppStorage.getMessages(chatId);
        const map = new Map(existing.map((message) => [message.id, message]));
        incomingMessages.forEach((message) => map.set(message.id, message));

        const merged = [...map.values()].sort((a, b) => a.id - b.id);
        window.AppStorage.setMessages(chatId, merged);
        return merged;
    }

    async function loadMessages(chatId, { before = null, appendToTop = false } = {}) {
        if (state.loadingMoreByChat[chatId]) {
            return;
        }

        state.loadingMoreByChat[chatId] = true;
        try {
            const result = await window.Api.getMessages(chatId, before, 30);
            const merged = mergeMessages(chatId, result.messages);
            state.hasMoreByChat[chatId] = result.has_more;

            if (!appendToTop) {
                renderMessages(chatId);
                scrollToBottom(false);
            } else {
                const previousHeight = els.messagesScroll.scrollHeight;
                renderMessages(chatId);
                const nextHeight = els.messagesScroll.scrollHeight;
                els.messagesScroll.scrollTop = nextHeight - previousHeight;
            }

            if (result.messages.length > 0) {
                const latest = result.messages[result.messages.length - 1];
                await markRead(chatId, latest.id);
            }

            return merged;
        } catch (error) {
            showToast(error.message || "Не удалось загрузить сообщения");
            return [];
        } finally {
            state.loadingMoreByChat[chatId] = false;
        }
    }

    async function markRead(chatId, messageId = null) {
        try {
            await window.Api.markChatRead(chatId, messageId);
            if (state.socket) {
                state.socket.emit("read_messages", {
                    chat_id: chatId,
                    message_id: messageId,
                });
            }
        } catch (error) {
            console.warn(error);
        }
    }

    function setReplyPreview(message) {
        state.replyToMessage = message;
        if (!message) {
            els.replyPreview.classList.add("hidden");
            els.replyPreview.innerHTML = "";
            return;
        }

        els.replyPreview.classList.remove("hidden");
        els.replyPreview.innerHTML = `Ответ: ${escapeHtml(message.content || "Вложение")}
            <button id="cancel-reply" class="btn btn-ghost" type="button">Отменить</button>`;

        const cancelBtn = document.getElementById("cancel-reply");
        cancelBtn.addEventListener("click", () => setReplyPreview(null));
    }

    async function openChat(chatId) {
        const chat = getChatById(chatId);
        if (!chat) {
            return;
        }

        state.currentChatId = chatId;
        renderChatList();
        renderChatHeader(chat);
        renderMessages(chatId);

        if (state.socket) {
            state.socket.emit("join_chat", { chat_id: chatId });
        }

        await loadMessages(chatId);
    }

    function closeContextMenu() {
        els.contextMenu.classList.add("hidden");
        els.contextMenu.style.left = "0";
        els.contextMenu.style.top = "0";
        els.contextMenu.dataset.messageId = "";
    }

    function openContextMenu(x, y, message) {
        if (!state.currentChatId) {
            return;
        }

        const isMine = message.sender_id === state.me.id;
        els.contextMenu.dataset.messageId = String(message.id);

        els.contextMenu.querySelectorAll("button").forEach((button) => {
            const action = button.dataset.action;
            if (action === "edit" || action === "delete") {
                button.style.display = isMine ? "block" : "none";
            } else {
                button.style.display = "block";
            }
        });

        els.contextMenu.style.left = `${x}px`;
        els.contextMenu.style.top = `${y}px`;
        els.contextMenu.classList.remove("hidden");

        state.contextMessage = message;
    }

    function showModal(html, onReady) {
        els.modal.innerHTML = html;
        els.modalOverlay.classList.remove("hidden");
        if (onReady) {
            onReady();
        }
    }

    function hideModal() {
        els.modalOverlay.classList.add("hidden");
        els.modal.innerHTML = "";
    }

    function renderTypingIndicator() {
        const chatId = state.currentChatId;
        if (!chatId) {
            els.typingIndicator.classList.add("hidden");
            return;
        }

        const usersSet = state.typingUsersByChat.get(chatId);
        if (!usersSet || usersSet.size === 0) {
            els.typingIndicator.classList.add("hidden");
            els.typingIndicator.textContent = "";
            return;
        }

        const users = [...usersSet]
            .map((userId) => {
                const chat = getChatById(chatId);
                const user = (chat?.members || []).find((member) => member.id === userId);
                return user?.display_name || "Кто-то";
            })
            .slice(0, 3);

        els.typingIndicator.classList.remove("hidden");
        els.typingIndicator.textContent = `${users.join(", ")} печатает...`;
    }

    function addIncomingMessage(message) {
        const chatId = message.chat_id;
        window.AppStorage.appendMessage(chatId, message);

        const chat = getChatById(chatId);
        if (chat) {
            chat.last_message = message;
            chat.last_message_at = message.created_at;
            if (chatId !== state.currentChatId && message.sender_id !== state.me.id) {
                chat.unread_count = (chat.unread_count || 0) + 1;
            }
            upsertChat(chat);
        }

        if (state.currentChatId === chatId) {
            renderMessage(message, { append: true });
            scrollToBottom(true);
            if (message.sender_id !== state.me.id) {
                markRead(chatId, message.id);
            }
        }

        if (message.sender_id !== state.me.id) {
            maybeNotify(message);
        }
    }

    function updateMessageInUI(message) {
        window.AppStorage.updateMessage(message.chat_id, message);
        if (state.currentChatId === message.chat_id) {
            renderMessages(message.chat_id);
        }
    }

    function deleteMessageInUI(chatId, messageId) {
        window.AppStorage.removeMessage(chatId, messageId);
        if (state.currentChatId === chatId) {
            renderMessages(chatId);
        }
    }

    function maybeNotify(message) {
        const chat = getChatById(message.chat_id);
        if (!chat) {
            return;
        }

        showToast(`Новое сообщение: ${chat.title}`);

        if (document.visibilityState === "visible") {
            return;
        }

        if (Notification.permission === "granted") {
            const text = message.content || "Вложение";
            const n = new Notification(chat.title, {
                body: text,
                icon: chat.avatar_url || "/static/icons/icon-192.svg",
            });
            n.onclick = () => {
                window.focus();
                openChat(chat.id);
            };
        }
    }

    async function sendMessage() {
        if (!state.currentChatId) {
            showToast("Сначала выберите чат");
            return;
        }

        const content = els.messageInput.value.trim();
        const files = [...state.selectedFiles];

        if (!content && files.length === 0) {
            return;
        }

        try {
            const editingMessageId = state.editMessageId;
            let result;
            if (editingMessageId) {
                result = await window.Api.editMessage(editingMessageId, content);
            } else {
                result = await window.Api.sendMessage({
                    chatId: state.currentChatId,
                    content,
                    replyToId: state.replyToMessage?.id || null,
                    files,
                });
            }

            if (result.message) {
                if (editingMessageId) {
                    updateMessageInUI(result.message);
                    state.editMessageId = null;
                    els.messageInput.placeholder = "Введите сообщение...";
                } else {
                    addIncomingMessage(result.message);
                }

                if (state.replyToMessage) {
                    setReplyPreview(null);
                }
                state.selectedFiles = [];
                els.fileInput.value = "";
                els.messageInput.value = "";
                els.messageInput.style.height = "42px";
            }
        } catch (error) {
            showToast(error.message || "Не удалось отправить сообщение");
        }
    }

    function openForwardModal(sourceMessageId) {
        const options = state.chats
            .filter((chat) => chat.id !== state.currentChatId)
            .map((chat) => `<option value="${chat.id}">${escapeHtml(chat.title)}</option>`)
            .join("");

        showModal(`
            <h3>Переслать сообщение</h3>
            <select id="forward-chat-select">${options}</select>
            <div class="modal-actions">
                <button id="forward-cancel" class="btn btn-ghost" type="button">Отмена</button>
                <button id="forward-confirm" class="btn btn-primary" type="button">Переслать</button>
            </div>
        `, () => {
            document.getElementById("forward-cancel").addEventListener("click", hideModal);
            document.getElementById("forward-confirm").addEventListener("click", async () => {
                const select = document.getElementById("forward-chat-select");
                const targetChatId = Number(select.value);
                if (!targetChatId) {
                    showToast("Выберите чат");
                    return;
                }

                try {
                    await window.Api.forwardMessage(sourceMessageId, targetChatId);
                    showToast("Сообщение переслано");
                    hideModal();
                } catch (error) {
                    showToast(error.message || "Не удалось переслать");
                }
            });
        });
    }

    function openGroupModal() {
        showModal(`
            <h3>Создать группу</h3>
            <input id="group-title" type="text" placeholder="Название группы" />
            <textarea id="group-description" rows="3" placeholder="Описание (необязательно)"></textarea>
            <input id="group-members" type="text" placeholder="ID участников через запятую" />
            <div class="modal-actions">
                <button id="group-cancel" class="btn btn-ghost" type="button">Отмена</button>
                <button id="group-create" class="btn btn-primary" type="button">Создать</button>
            </div>
        `, () => {
            document.getElementById("group-cancel").addEventListener("click", hideModal);
            document.getElementById("group-create").addEventListener("click", async () => {
                const title = document.getElementById("group-title").value.trim();
                const description = document.getElementById("group-description").value.trim();
                const members = document.getElementById("group-members").value
                    .split(",")
                    .map((value) => Number(value.trim()))
                    .filter((id) => Number.isInteger(id) && id > 0);

                if (!title) {
                    showToast("Введите название группы");
                    return;
                }

                try {
                    const result = await window.Api.createGroupChat({
                        title,
                        description,
                        member_ids: members,
                    });
                    upsertChat(result.chat);
                    hideModal();
                    openChat(result.chat.id);
                } catch (error) {
                    showToast(error.message || "Не удалось создать группу");
                }
            });
        });
    }

    function renderSearchResults(users) {
        els.searchResults.innerHTML = "";

        if (!users || users.length === 0) {
            els.searchResults.innerHTML = "<div class='search-item'>Ничего не найдено</div>";
            return;
        }

        users.forEach((user) => {
            const item = document.createElement("div");
            item.className = "search-item";
            item.innerHTML = `
                <img class="avatar" src="${user.avatar_url || "https://placehold.co/80x80/35536f/FFFFFF?text=U"}" alt="user" />
                <div>
                    <div>${escapeHtml(user.display_name)}</div>
                    <div class="me-username">@${escapeHtml(user.username)}</div>
                </div>
            `;
            item.addEventListener("click", async () => {
                try {
                    const result = await window.Api.createPrivateChat(user.id);
                    upsertChat(result.chat);
                    els.searchResults.innerHTML = "";
                    els.userSearch.value = "";
                    openChat(result.chat.id);
                } catch (error) {
                    showToast(error.message || "Не удалось создать чат");
                }
            });
            els.searchResults.appendChild(item);
        });
    }

    function wireEvents() {
        els.logoutBtn.addEventListener("click", () => {
            window.AppStorage.clearAuth();
            window.location.href = "/login";
        });

        els.themeToggle.addEventListener("click", () => {
            const current = document.documentElement.getAttribute("data-theme");
            const next = current === "dark" ? "light" : "dark";
            document.documentElement.setAttribute("data-theme", next);
            localStorage.setItem("theme", next);
        });

        els.avatarInput.addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            if (!file) {
                return;
            }
            try {
                const result = await window.Api.uploadAvatar(file);
                state.me = result.user;
                window.AppStorage.setUser(state.me);
                renderMe();
                showToast("Аватар обновлен");
            } catch (error) {
                showToast(error.message || "Не удалось загрузить аватар");
            }
        });

        els.userSearch.addEventListener("input", async () => {
            const query = els.userSearch.value.trim();
            if (query.length < 2) {
                els.searchResults.innerHTML = "";
                return;
            }

            try {
                const result = await window.Api.searchUsers(query);
                renderSearchResults(result.users);
            } catch (error) {
                console.warn(error);
            }
        });

        els.newPrivateChatBtn.addEventListener("click", () => {
            els.userSearch.focus();
        });

        els.newGroupChatBtn.addEventListener("click", openGroupModal);

        els.sendBtn.addEventListener("click", sendMessage);

        els.attachBtn.addEventListener("click", () => els.fileInput.click());

        els.fileInput.addEventListener("change", (event) => {
            state.selectedFiles = [...(event.target.files || [])];
            if (state.selectedFiles.length > 0) {
                showToast(`Выбрано файлов: ${state.selectedFiles.length}`);
            }
        });

        els.messageInput.addEventListener("input", () => {
            els.messageInput.style.height = "auto";
            els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 130)}px`;

            if (!state.socket || !state.currentChatId) {
                return;
            }

            state.socket.emit("typing", {
                chat_id: state.currentChatId,
                is_typing: true,
            });

            clearTimeout(state.typingTimer);
            state.typingTimer = setTimeout(() => {
                state.socket.emit("typing", {
                    chat_id: state.currentChatId,
                    is_typing: false,
                });
            }, 1300);
        });

        els.messageInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        els.emojiBtn.addEventListener("click", () => {
            els.emojiPanel.classList.toggle("hidden");
        });

        window.APP_CONFIG.emojiList.forEach((emoji) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "emoji-item";
            button.textContent = emoji;
            button.addEventListener("click", () => {
                els.messageInput.value += emoji;
                els.messageInput.focus();
            });
            els.emojiPanel.appendChild(button);
        });

        els.archiveChatBtn.addEventListener("click", async () => {
            if (!state.currentChatId) {
                return;
            }

            const chat = getChatById(state.currentChatId);
            const next = !chat.is_archived;
            try {
                await window.Api.archiveChat(state.currentChatId, next);
                chat.is_archived = next;
                if (next) {
                    state.currentChatId = null;
                    renderChatHeader(null);
                }
                state.chats = state.chats.filter((item) => !item.is_archived);
                window.AppStorage.setChats(state.chats);
                renderChatList();
                showToast(next ? "Чат отправлен в архив" : "Чат восстановлен");
            } catch (error) {
                showToast(error.message || "Не удалось изменить архив");
            }
        });

        els.messagesScroll.addEventListener("scroll", async () => {
            if (!state.currentChatId) {
                return;
            }

            if (els.messagesScroll.scrollTop > 90) {
                return;
            }

            if (!state.hasMoreByChat[state.currentChatId]) {
                return;
            }

            const messages = window.AppStorage.getMessages(state.currentChatId);
            if (!messages.length) {
                return;
            }

            const oldestId = messages[0].id;
            await loadMessages(state.currentChatId, {
                before: oldestId,
                appendToTop: true,
            });
        });

        document.addEventListener("click", (event) => {
            if (!els.contextMenu.contains(event.target)) {
                closeContextMenu();
            }

            if (!els.searchResults.contains(event.target) && event.target !== els.userSearch) {
                els.searchResults.innerHTML = "";
            }

            if (!els.emojiPanel.contains(event.target) && event.target !== els.emojiBtn) {
                els.emojiPanel.classList.add("hidden");
            }
        });

        els.contextMenu.addEventListener("click", async (event) => {
            const button = event.target.closest("button[data-action]");
            if (!button || !state.contextMessage) {
                return;
            }

            const action = button.dataset.action;
            const message = state.contextMessage;
            closeContextMenu();

            if (action === "reply") {
                setReplyPreview(message);
                return;
            }

            if (action === "edit") {
                state.editMessageId = message.id;
                els.messageInput.value = message.content || "";
                els.messageInput.placeholder = "Редактирование сообщения...";
                els.messageInput.focus();
                return;
            }

            if (action === "forward") {
                openForwardModal(message.id);
                return;
            }

            if (action === "pin") {
                try {
                    const result = await window.Api.pinMessage(message.id);
                    const chat = getChatById(message.chat_id);
                    if (chat) {
                        chat.pinned_message = result.message;
                        renderChatHeader(chat);
                    }
                    showToast("Сообщение закреплено");
                } catch (error) {
                    showToast(error.message || "Не удалось закрепить");
                }
                return;
            }

            if (action === "delete") {
                try {
                    await window.Api.deleteMessage(message.id);
                    deleteMessageInUI(message.chat_id, message.id);
                    showToast("Сообщение удалено");
                } catch (error) {
                    showToast(error.message || "Не удалось удалить сообщение");
                }
            }
        });

        els.modalOverlay.addEventListener("click", (event) => {
            if (event.target === els.modalOverlay) {
                hideModal();
            }
        });
    }

    function initSocket() {
        if (typeof io === "undefined") {
            showToast("WebSocket недоступен: offline режим без realtime");
            return;
        }

        state.socket = io({
            auth: { token },
            transports: ["websocket", "polling"],
        });

        state.socket.on("connect", () => {
            state.socket.emit("presence_ping");
        });

        state.socket.on("new_message", (payload) => {
            if (!payload?.message) {
                return;
            }
            addIncomingMessage(payload.message);
        });

        state.socket.on("message_updated", (payload) => {
            if (!payload?.message) {
                return;
            }
            updateMessageInUI(payload.message);
        });

        state.socket.on("message_deleted", (payload) => {
            if (!payload?.message_id) {
                return;
            }
            const chatId = payload.chat_id;
            if (chatId) {
                deleteMessageInUI(chatId, payload.message_id);
            }
        });

        state.socket.on("message_pinned", (payload) => {
            if (!payload?.message) {
                return;
            }
            const chat = getChatById(payload.message.chat_id);
            if (chat) {
                chat.pinned_message = payload.message;
                if (state.currentChatId === chat.id) {
                    renderChatHeader(chat);
                }
            }
        });

        state.socket.on("message_unpinned", (payload) => {
            if (!payload?.message_id) {
                return;
            }
            const chat = getChatById(state.currentChatId);
            if (chat) {
                chat.pinned_message = null;
                renderChatHeader(chat);
            }
        });

        state.socket.on("chat_updated", (payload) => {
            if (!payload?.chat) {
                return;
            }
            upsertChat(payload.chat);
            if (state.currentChatId === payload.chat.id) {
                renderChatHeader(payload.chat);
            }
        });

        state.socket.on("typing", (payload) => {
            const chatId = payload.chat_id;
            if (!chatId) {
                return;
            }

            if (!state.typingUsersByChat.has(chatId)) {
                state.typingUsersByChat.set(chatId, new Set());
            }
            const users = state.typingUsersByChat.get(chatId);

            if (payload.is_typing) {
                users.add(payload.user_id);
            } else {
                users.delete(payload.user_id);
            }

            renderTypingIndicator();
        });

        state.socket.on("messages_read", (payload) => {
            if (!payload?.chat_id) {
                return;
            }
            const chatId = payload.chat_id;
            const messages = window.AppStorage.getMessages(chatId);
            const updated = messages.map((message) => {
                if (message.id <= payload.last_read_message_id) {
                    const already = (message.read_by || []).some((entry) => entry.user_id === payload.user_id);
                    if (!already) {
                        return {
                            ...message,
                            read_by: [...(message.read_by || []), { user_id: payload.user_id }],
                        };
                    }
                }
                return message;
            });
            window.AppStorage.setMessages(chatId, updated);
            if (state.currentChatId === chatId) {
                renderMessages(chatId);
            }
        });

        state.socket.on("user_status", (payload) => {
            const userId = payload.user_id;
            state.chats.forEach((chat) => {
                chat.members = (chat.members || []).map((member) => (
                    member.id === userId
                        ? { ...member, is_online: payload.is_online }
                        : member
                ));

                if (!chat.is_group) {
                    const other = chat.members.find((member) => member.id !== state.me.id);
                    if (other) {
                        chat.online = other.is_online;
                    }
                }
            });

            const current = getChatById(state.currentChatId);
            if (current) {
                renderChatHeader(current);
            }
        });

        state.socket.on("connect_error", (error) => {
            console.warn("socket connect error", error);
        });
    }

    async function boot() {
        try {
            const meResponse = await window.Api.me();
            state.me = meResponse.user;
            window.AppStorage.setUser(state.me);
            renderMe();

            const chatsResponse = await window.Api.listChats(false);
            state.chats = chatsResponse.chats || [];
            sortChats();
            window.AppStorage.setChats(state.chats);
            renderChatList();

            if (state.chats.length > 0) {
                await openChat(state.chats[0].id);
            } else {
                renderChatHeader(null);
            }
        } catch (error) {
            console.error(error);
            window.AppStorage.clearAuth();
            window.location.href = "/login";
            return;
        }

        wireEvents();

        try {
            initSocket();
        } catch (error) {
            console.warn("Socket init failed:", error);
            showToast("Realtime временно недоступен");
        }
    }

    boot();
})();
