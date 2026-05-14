export function initChatsModule(app) {
    const { api, refs, state, storage, helpers } = app;

    const deps = {
        messages: null,
    };

    let searchDebounceId = null;
    let glowChatItemElement = null;

    function sortChats() {
        state.chats.sort((left, right) => {
            const leftTs = new Date(left.last_message_at || left.created_at || 0).getTime();
            const rightTs = new Date(right.last_message_at || right.created_at || 0).getTime();
            return rightTs - leftTs;
        });
    }

    function persistChats() {
        storage.setChats(state.chats);
    }

    function getChatById(chatId) {
        return state.chats.find((chat) => chat.id === Number(chatId)) || null;
    }

    function isChatVisibleForRead() {
        return document.visibilityState === "visible" && document.hasFocus();
    }

    function getChatPreview(chat) {
        if (!chat?.last_message) {
            return "Нет сообщений";
        }

        const { last_message: lastMessage } = chat;

        if (lastMessage.is_deleted) {
            return "Сообщение удалено";
        }

        if (lastMessage.content) {
            return lastMessage.content;
        }

        if (lastMessage.attachments?.length) {
            const first = lastMessage.attachments[0];
            return first.kind === "image" ? "Фото" : "Файл";
        }

        return "Сообщение";
    }

    function isPinnedChat(chat) {
        if (!chat) {
            return false;
        }

        if (chat.is_pinned) {
            return true;
        }

        if (chat.pinned_at) {
            return true;
        }

        const pinOrder = Number(chat.pin_order);
        return Number.isFinite(pinOrder);
    }

    function createChatListItem(chat) {
        const item = document.createElement("article");
        item.className = `chat-item ${state.currentChatId === chat.id ? "active" : ""}`;
        item.dataset.chatId = String(chat.id);

        if (isPinnedChat(chat)) {
            item.classList.add("chat-item--pinned");
        }

        const avatarWrap = document.createElement("div");
        avatarWrap.className = "chat-item__avatar";

        const avatar = document.createElement("img");
        avatar.className = "avatar avatar-sm";
        avatar.src = chat.avatar_url || helpers.avatarFallback(chat.title, true);
        avatar.alt = chat.title || "chat avatar";
        avatarWrap.appendChild(avatar);

        if (!chat.is_group && chat.online) {
            const statusDot = document.createElement("span");
            statusDot.className = "status-dot online";
            avatarWrap.appendChild(statusDot);
        }

        const main = document.createElement("div");
        main.className = "chat-item__main";

        const titleRow = document.createElement("div");
        titleRow.className = "chat-item__title-row";

        const title = document.createElement("div");
        title.className = "chat-item__title";
        title.textContent = chat.title || "Без названия";
        titleRow.append(title);

        if (chat.is_group) {
            const groupBadge = document.createElement("span");
            groupBadge.className = "chat-item__group-badge";
            groupBadge.textContent = "Группа";
            titleRow.append(groupBadge);
        }

        if (isPinnedChat(chat)) {
            const pinBadge = document.createElement("span");
            pinBadge.className = "chat-item__pin";
            pinBadge.innerHTML = "<i class=\"fa-solid fa-thumbtack\"></i>";
            titleRow.append(pinBadge);
        }

        const preview = document.createElement("div");
        preview.className = "chat-item__preview";
        preview.textContent = getChatPreview(chat);

        main.append(titleRow, preview);

        const extra = document.createElement("div");
        extra.className = "chat-item__extra";

        const time = document.createElement("div");
        time.className = "chat-item__time";
        time.textContent = helpers.formatChatTime(chat.last_message_at || chat.created_at);
        extra.appendChild(time);

        if (chat.unread_count > 0) {
            const unreadBadge = document.createElement("span");
            unreadBadge.className = "badge";
            unreadBadge.textContent = String(chat.unread_count > 99 ? "99+" : chat.unread_count);
            extra.appendChild(unreadBadge);
        }

        item.append(avatarWrap, main, extra);
        item.addEventListener("click", () => {
            void openChat(chat.id);
        });

        return item;
    }

    function appendChatSection(title, chats) {
        if (!chats.length) {
            return;
        }

        const section = document.createElement("section");
        section.className = "chat-list-section";

        const head = document.createElement("div");
        head.className = "chat-list-section__title";
        head.textContent = title;

        const body = document.createElement("div");
        body.className = "chat-list-section__items";
        chats.forEach((chat) => body.appendChild(createChatListItem(chat)));

        section.append(head, body);
        refs.chatList.appendChild(section);
    }

    function renderChatList() {
        sortChats();
        refs.chatList.innerHTML = "";

        if (!state.chats.length) {
            const empty = document.createElement("div");
            empty.className = "chat-list-empty";
            empty.innerHTML = `
                <div class="chat-empty-icon"><i class="fa-regular fa-comments"></i></div>
                <div class="chat-list-empty__title">Нет чатов</div>
                <div class="chat-list-empty__text">Начните диалог через поиск пользователей.</div>
            `;
            refs.chatList.appendChild(empty);
            return;
        }

        const pinnedChats = state.chats.filter((chat) => isPinnedChat(chat));
        const regularChats = state.chats.filter((chat) => !isPinnedChat(chat));

        if (pinnedChats.length) {
            appendChatSection("Закрепленные", pinnedChats);
        }

        if (regularChats.length) {
            appendChatSection(pinnedChats.length ? "Все чаты" : "Чаты", regularChats);
        }
    }

    function updateArchivedButton() {
        refs.toggleArchivedBtn.textContent = state.showArchived ? "Активные" : "Архив";
    }

    function isChatVisibleInCurrentMode(chat) {
        if (!chat) {
            return false;
        }
        return state.showArchived ? Boolean(chat.is_archived) : !chat.is_archived;
    }

    function upsertChat(chat) {
        if (!chat?.id) {
            return;
        }

        if (!isChatVisibleInCurrentMode(chat)) {
            removeChat(chat.id);
            return;
        }

        const index = state.chats.findIndex((item) => item.id === chat.id);
        if (index >= 0) {
            state.chats[index] = {
                ...state.chats[index],
                ...chat,
            };
        } else {
            state.chats.push(chat);
        }

        sortChats();
        persistChats();
        renderChatList();

        if (state.currentChatId === chat.id) {
            helpers.setChatHeader(getChatById(chat.id));
        }
    }

    function removeChat(chatId) {
        state.chats = state.chats.filter((chat) => chat.id !== Number(chatId));
        persistChats();
        renderChatList();
    }

    async function loadChats() {
        try {
            const response = await api.listChats(state.showArchived);
            state.chats = response.chats || [];
            sortChats();
            persistChats();
            renderChatList();
            updateArchivedButton();
            return state.chats;
        } catch (error) {
            helpers.showToast(error.message || "Не удалось загрузить чаты");
            const cached = storage.getChats();
            state.chats = Array.isArray(cached) ? cached : [];
            renderChatList();
            updateArchivedButton();
            return state.chats;
        }
    }

    function renderSearchResults(users) {
        refs.searchResults.innerHTML = "";
        refs.searchResults.classList.remove("hidden");

        if (!users.length) {
            const empty = document.createElement("div");
            empty.className = "search-item";
            empty.innerHTML = "<div class=\"search-item__name\">Ничего не найдено</div>";
            refs.searchResults.appendChild(empty);
            return;
        }

        users.forEach((user) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "search-item";
            item.innerHTML = `
                <img class="avatar avatar-sm" src="${user.avatar_url || helpers.avatarFallback(user.display_name)}" alt="${helpers.escapeHtml(user.display_name)}" />
                <div class="search-item__meta">
                    <div class="search-item__name">${helpers.escapeHtml(user.display_name)}</div>
                    <div class="search-item__username">@${helpers.escapeHtml(user.username)}</div>
                </div>
                <span class="status-dot ${user.is_online ? "online" : ""}"></span>
            `;

            item.addEventListener("click", async () => {
                try {
                    const result = await api.createPrivateChat(user.id);
                    upsertChat(result.chat);
                    refs.userSearch.value = "";
                    refs.searchResults.classList.add("hidden");
                    refs.searchResults.innerHTML = "";
                    await openChat(result.chat.id);
                } catch (error) {
                    helpers.showToast(error.message || "Не удалось создать диалог");
                }
            });

            refs.searchResults.appendChild(item);
        });
    }

    async function performSearch(query) {
        if (query.length < 2) {
            refs.searchResults.classList.add("hidden");
            refs.searchResults.innerHTML = "";
            return;
        }

        try {
            const result = await api.searchUsers(query);
            renderSearchResults(result.users || []);
        } catch (error) {
            console.warn("search failed", error);
        }
    }

    function parseMemberIds(raw) {
        if (!raw) {
            return [];
        }

        const ids = raw
            .split(",")
            .map((item) => Number(item.trim()))
            .filter((value) => Number.isInteger(value) && value > 0);

        return [...new Set(ids)];
    }

    function openGroupModal() {
        const selectedMembers = new Map();

        helpers.showModal(`
            <h3>Новая группа</h3>
            <div class="modal-group">
                <label class="input-label" for="group-title-input">Название</label>
                <input id="group-title-input" type="text" placeholder="Название группы" maxlength="120" />
            </div>
            <div class="modal-group">
                <label class="input-label" for="group-description-input">Описание</label>
                <textarea id="group-description-input" rows="3" placeholder="Необязательно"></textarea>
            </div>
            <div class="modal-group">
                <label class="input-label" for="group-members-search">Добавить участников</label>
                <input id="group-members-search" type="search" placeholder="Введите имя пользователя" />
                <div id="group-members-results" class="search-results hidden"></div>
            </div>
            <div class="modal-group">
                <label class="input-label" for="group-members-ids">ID участников через запятую (опционально)</label>
                <input id="group-members-ids" type="text" placeholder="2, 15, 18" />
            </div>
            <div id="group-selected-members" class="selected-members"></div>
            <div class="modal-actions">
                <button id="group-cancel" class="btn btn-soft" type="button">Отмена</button>
                <button id="group-create" class="btn btn-primary" type="button">Создать</button>
            </div>
        `, () => {
            const titleInput = document.getElementById("group-title-input");
            const descriptionInput = document.getElementById("group-description-input");
            const membersSearchInput = document.getElementById("group-members-search");
            const membersResults = document.getElementById("group-members-results");
            const manualIdsInput = document.getElementById("group-members-ids");
            const selectedContainer = document.getElementById("group-selected-members");
            const cancelBtn = document.getElementById("group-cancel");
            const createBtn = document.getElementById("group-create");

            const renderSelectedMembers = () => {
                selectedContainer.innerHTML = "";
                if (!selectedMembers.size) {
                    return;
                }

                selectedMembers.forEach((member) => {
                    const chip = document.createElement("div");
                    chip.className = "selected-member-chip";
                    chip.innerHTML = `
                        <span>${helpers.escapeHtml(member.display_name)}</span>
                        <button type="button" aria-label="Удалить"><i class="fa-solid fa-xmark"></i></button>
                    `;
                    chip.querySelector("button").addEventListener("click", () => {
                        selectedMembers.delete(member.id);
                        renderSelectedMembers();
                    });
                    selectedContainer.appendChild(chip);
                });
            };

            const searchInModal = async () => {
                const query = membersSearchInput.value.trim();
                if (query.length < 2) {
                    membersResults.classList.add("hidden");
                    membersResults.innerHTML = "";
                    return;
                }

                try {
                    const result = await api.searchUsers(query);
                    membersResults.innerHTML = "";
                    membersResults.classList.remove("hidden");

                    const users = result.users || [];
                    if (!users.length) {
                        const empty = document.createElement("div");
                        empty.className = "search-item";
                        empty.textContent = "Ничего не найдено";
                        membersResults.appendChild(empty);
                        return;
                    }

                    users.forEach((user) => {
                        const item = document.createElement("button");
                        item.type = "button";
                        item.className = "search-item";
                        item.innerHTML = `
                            <img class="avatar avatar-sm" src="${user.avatar_url || helpers.avatarFallback(user.display_name)}" alt="${helpers.escapeHtml(user.display_name)}" />
                            <div class="search-item__meta">
                                <div class="search-item__name">${helpers.escapeHtml(user.display_name)}</div>
                                <div class="search-item__username">@${helpers.escapeHtml(user.username)}</div>
                            </div>
                        `;

                        item.addEventListener("click", () => {
                            selectedMembers.set(user.id, user);
                            renderSelectedMembers();
                            membersResults.classList.add("hidden");
                            membersResults.innerHTML = "";
                            membersSearchInput.value = "";
                        });

                        membersResults.appendChild(item);
                    });
                } catch (error) {
                    console.warn("group search failed", error);
                }
            };

            let modalSearchTimer = null;
            membersSearchInput.addEventListener("input", () => {
                window.clearTimeout(modalSearchTimer);
                modalSearchTimer = window.setTimeout(searchInModal, 220);
            });

            cancelBtn.addEventListener("click", helpers.hideModal);
            createBtn.addEventListener("click", async () => {
                const title = titleInput.value.trim();
                const description = descriptionInput.value.trim();

                if (title.length < 2) {
                    helpers.showToast("Название группы должно быть от 2 символов");
                    return;
                }

                const manualIds = parseMemberIds(manualIdsInput.value);
                const selectedIds = [...selectedMembers.keys()];
                const memberIds = [...new Set([...manualIds, ...selectedIds])];

                createBtn.disabled = true;
                try {
                    const result = await api.createGroupChat({
                        title,
                        description,
                        member_ids: memberIds,
                    });

                    helpers.hideModal();
                    upsertChat(result.chat);
                    await openChat(result.chat.id);
                    helpers.showToast("Группа создана");
                } catch (error) {
                    helpers.showToast(error.message || "Не удалось создать группу");
                } finally {
                    createBtn.disabled = false;
                }
            });
        });
    }

    async function toggleArchiveForCurrentChat() {
        if (!state.currentChatId) {
            return;
        }

        const currentChat = getChatById(state.currentChatId);
        if (!currentChat) {
            return;
        }

        const nextArchiveState = !currentChat.is_archived;

        try {
            await api.archiveChat(currentChat.id, nextArchiveState);
            currentChat.is_archived = nextArchiveState;

            const movedOutOfCurrentList = (
                (!state.showArchived && nextArchiveState)
                || (state.showArchived && !nextArchiveState)
            );

            if (movedOutOfCurrentList) {
                removeChat(currentChat.id);
                state.currentChatId = null;

                const fallback = state.chats[0] || null;
                if (fallback) {
                    await openChat(fallback.id);
                } else {
                    helpers.setChatHeader(null);
                    helpers.setMessagesEmptyState(true);
                    refs.messagesList.innerHTML = "";
                }
            } else {
                upsertChat(currentChat);
            }

            helpers.showToast(nextArchiveState ? "Чат перенесен в архив" : "Чат восстановлен");
        } catch (error) {
            helpers.showToast(error.message || "Не удалось изменить статус архива");
        }
    }

    async function openChat(chatId) {
        const id = Number(chatId);

        let chat = getChatById(id);
        if (!chat) {
            try {
                const response = await api.getChat(id);
                chat = response.chat;
                upsertChat(chat);
            } catch (error) {
                helpers.showToast(error.message || "Чат недоступен");
                return;
            }
        }

        if (state.currentChatId === id) {
            return;
        }

        if (app.modules.socket && state.currentChatId) {
            app.modules.socket.leaveChat(state.currentChatId);
        }

        state.currentChatId = id;
        renderChatList();
        helpers.setChatHeader(chat);

        if (window.innerWidth <= 900) {
            helpers.setSidebarOpen(false);
        }

        if (deps.messages) {
            await deps.messages.openChat(id, chat);
        }

        if (app.modules.socket) {
            app.modules.socket.joinChat(id);
        }
    }

    function touchChatFromMessage(message) {
        const chat = getChatById(message.chat_id);
        if (!chat) {
            return;
        }

        chat.last_message = message;
        chat.last_message_at = message.created_at;

        const activeVisibleChat = state.currentChatId === chat.id && isChatVisibleForRead();

        if (message.sender_id !== state.me.id && !activeVisibleChat) {
            chat.unread_count = (chat.unread_count || 0) + 1;
        } else if (activeVisibleChat) {
            chat.unread_count = 0;
        }

        upsertChat(chat);
    }

    function applyChatPayload(chatPayload) {
        if (!chatPayload?.id) {
            return;
        }

        upsertChat(chatPayload);

        if (state.currentChatId === chatPayload.id) {
            const currentChat = getChatById(chatPayload.id);
            if (currentChat) {
                helpers.setChatHeader(currentChat);
            }
        }
    }

    function updateUserPresence(userId, isOnline) {
        state.chats = state.chats.map((chat) => {
            const members = (chat.members || []).map((member) => (
                member.id === userId
                    ? { ...member, is_online: isOnline }
                    : member
            ));

            let online = chat.online;
            if (!chat.is_group) {
                const otherMember = members.find((member) => member.id !== state.me.id);
                if (otherMember) {
                    online = otherMember.is_online;
                }
            }

            return {
                ...chat,
                members,
                online,
            };
        });

        persistChats();

        if (state.currentChatId) {
            const current = getChatById(state.currentChatId);
            if (current) {
                helpers.setChatHeader(current);
            }
        }

        renderChatList();
    }

    function markCurrentChatRead(lastMessageId = null) {
        if (!state.currentChatId) {
            return;
        }

        const chat = getChatById(state.currentChatId);
        if (!chat) {
            return;
        }

        chat.unread_count = 0;
        if (lastMessageId) {
            chat.last_read_message_id = lastMessageId;
        }

        upsertChat(chat);
    }

    function clearChatListCursorGlow() {
        if (!glowChatItemElement) {
            return;
        }
        glowChatItemElement.classList.remove("chat-item--glow-active");
        glowChatItemElement = null;
    }

    function handleChatListCursorGlow(event) {
        const item = event.target.closest(".chat-item");
        if (!item || !refs.chatList.contains(item)) {
            clearChatListCursorGlow();
            return;
        }

        const rect = item.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        item.style.setProperty("--glow-x", `${x}px`);
        item.style.setProperty("--glow-y", `${y}px`);

        if (glowChatItemElement && glowChatItemElement !== item) {
            glowChatItemElement.classList.remove("chat-item--glow-active");
        }

        item.classList.add("chat-item--glow-active");
        glowChatItemElement = item;
    }

    function bindEvents() {
        refs.chatList.addEventListener("pointermove", handleChatListCursorGlow);
        refs.chatList.addEventListener("pointerleave", clearChatListCursorGlow);
        refs.chatList.addEventListener("pointercancel", clearChatListCursorGlow);

        refs.userSearch.addEventListener("input", () => {
            const query = refs.userSearch.value.trim();
            window.clearTimeout(searchDebounceId);
            searchDebounceId = window.setTimeout(() => {
                void performSearch(query);
            }, 220);
        });

        refs.newGroupChatBtn?.addEventListener("click", openGroupModal);

        refs.toggleArchivedBtn.addEventListener("click", async () => {
            state.showArchived = !state.showArchived;
            await loadChats();

            if (state.chats.length > 0) {
                await openChat(state.chats[0].id);
            } else {
                state.currentChatId = null;
                refs.messagesList.innerHTML = "";
                helpers.setMessagesEmptyState(true);
                helpers.setChatHeader(null);
            }
        });

        refs.avatarInput.addEventListener("change", async (event) => {
            const file = event.target.files?.[0];
            if (!file) {
                return;
            }

            try {
                const result = await api.uploadAvatar(file);
                state.me = result.user;
                storage.setUser(result.user);
                helpers.renderMe(result.user);
                helpers.showToast("Аватар обновлен");
            } catch (error) {
                helpers.showToast(error.message || "Ошибка загрузки аватара");
            } finally {
                refs.avatarInput.value = "";
            }
        });
    }

    function attachDependencies(nextDeps) {
        deps.messages = nextDeps.messages;
    }

    return {
        attachDependencies,
        bindEvents,
        loadChats,
        openChat,
        getChatById,
        upsertChat,
        touchChatFromMessage,
        applyChatPayload,
        updateUserPresence,
        markCurrentChatRead,
        toggleArchiveForCurrentChat,
    };
}
