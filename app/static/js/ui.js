import { initChatsModule } from "./chats.js";
import { initMessagesModule } from "./messages.js";
import { initUploadsModule } from "./uploads.js";
import { initSocketModule } from "./socket.js";
import { initCallsModule } from "./calls.js";

const token = window.AppStorage.getToken();
if (!token) {
    window.location.href = "/login";
}

const refs = {
    appRoot: document.getElementById("app-root"),
    sidebar: document.getElementById("sidebar"),
    mobileOpenSidebar: document.getElementById("mobile-open-sidebar"),
    mobileCloseSidebar: document.getElementById("mobile-close-sidebar"),

    meAvatar: document.getElementById("me-avatar"),
    meName: document.getElementById("me-name"),
    meUsername: document.getElementById("me-username"),

    avatarInput: document.getElementById("avatar-input"),
    logoutBtn: document.getElementById("logout-btn"),
    themeToggle: document.getElementById("theme-toggle"),

    userSearch: document.getElementById("user-search"),
    searchResults: document.getElementById("search-results"),

    newGroupChatBtn: document.getElementById("new-group-chat-btn"),
    toggleArchivedBtn: document.getElementById("toggle-archived-btn"),

    chatList: document.getElementById("chat-list"),
    chatListSkeleton: document.getElementById("chat-list-skeleton"),

    chatAvatar: document.getElementById("chat-avatar"),
    chatTitle: document.getElementById("chat-title"),
    chatSubtitle: document.getElementById("chat-subtitle"),
    callActionBtn: document.getElementById("call-action-btn"),
    videoActionBtn: document.getElementById("video-action-btn"),
    menuActionBtn: document.getElementById("menu-action-btn"),

    pinnedWrapper: document.getElementById("pinned-wrapper"),
    messagesScroll: document.getElementById("messages-scroll"),
    messagesLoader: document.getElementById("messages-loader"),
    messagesList: document.getElementById("messages-list"),
    chatEmpty: document.getElementById("chat-empty"),
    typingIndicator: document.getElementById("typing-indicator"),
    scrollToLatestBtn: document.getElementById("scroll-to-latest-btn"),

    replyPreview: document.getElementById("reply-preview"),
    composer: document.getElementById("composer"),
    dropZone: document.getElementById("drop-zone"),
    uploadPreview: document.getElementById("upload-preview"),

    messageInput: document.getElementById("message-input"),
    attachBtn: document.getElementById("attach-btn"),
    fileInput: document.getElementById("file-input"),
    sendBtn: document.getElementById("send-btn"),
    voiceBtn: document.getElementById("voice-btn"),
    emojiBtn: document.getElementById("emoji-btn"),
    emojiPanel: document.getElementById("emoji-panel"),

    contextMenu: document.getElementById("context-menu"),
    chatActionsMenu: document.getElementById("chat-actions-menu"),
    chatToTopAction: document.getElementById("chat-to-top-action"),
    chatSearchAction: document.getElementById("chat-search-action"),
    chatArchiveAction: document.getElementById("chat-archive-action"),
    chatClearHistoryAction: document.getElementById("chat-clear-history-action"),
    chatDeleteAction: document.getElementById("chat-delete-action"),
    modalOverlay: document.getElementById("modal-overlay"),
    modal: document.getElementById("modal"),
    toastStack: document.getElementById("toast-stack"),
};

const state = {
    token,
    me: null,
    chats: [],
    currentChatId: null,
    selectedFiles: [],
    replyToMessage: null,
    editingMessageId: null,
    showArchived: false,
    sidebarOpen: false,
    typingUsersByChat: new Map(),
    lazyStateByChat: {},
};

function initials(text) {
    if (!text) {
        return "U";
    }
    const words = text.split(" ").filter(Boolean);
    if (words.length === 1) {
        return words[0].slice(0, 2).toUpperCase();
    }
    return (words[0][0] + words[1][0]).toUpperCase();
}

function avatarFallback(name, isChat = false) {
    const seed = initials(name || (isChat ? "Chat" : "User"));
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <rect width="96" height="96" fill="#1e293b"/>
    <text
        x="50%"
        y="50%"
        fill="#f8fafc"
        font-family="Plus Jakarta Sans, Segoe UI, sans-serif"
        font-size="34"
        font-weight="700"
        text-anchor="middle"
        dominant-baseline="central"
    >${seed}</text>
</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function showToast(message, timeout = 2800) {
    if (!refs.toastStack) {
        return;
    }

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    refs.toastStack.appendChild(toast);

    window.setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(6px)";
        window.setTimeout(() => toast.remove(), 180);
    }, timeout);
}

function showModal(html, onReady) {
    refs.modal.classList.remove("modal--media-preview");
    refs.modalOverlay.classList.remove("modal-overlay--media-preview");
    refs.modal.innerHTML = html;
    refs.modalOverlay.classList.remove("hidden");
    if (typeof onReady === "function") {
        onReady();
    }
}

function hideModal() {
    refs.modalOverlay.classList.add("hidden");
    refs.modalOverlay.classList.remove("modal-overlay--media-preview");
    refs.modal.classList.remove("modal--media-preview");
    refs.modal.innerHTML = "";
}

function closeContextMenu() {
    refs.contextMenu.classList.add("hidden");
    refs.contextMenu.style.left = "0px";
    refs.contextMenu.style.top = "0px";
}

function closeChatActionsMenu() {
    if (!refs.chatActionsMenu) {
        return;
    }
    refs.chatActionsMenu.classList.add("hidden");
    refs.chatActionsMenu.style.left = "0px";
    refs.chatActionsMenu.style.top = "0px";
}

function openFloatingMenu(menuElement, x, y) {
    if (!menuElement) {
        return;
    }

    menuElement.classList.remove("hidden");

    const padding = 8;
    const menuRect = menuElement.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuRect.width - padding;
    const maxTop = window.innerHeight - menuRect.height - padding;

    const left = Math.min(Math.max(x, padding), Math.max(padding, maxLeft));
    const top = Math.min(Math.max(y, padding), Math.max(padding, maxTop));

    menuElement.style.left = `${left}px`;
    menuElement.style.top = `${top}px`;
}

function openContextMenu(x, y) {
    closeChatActionsMenu();
    openFloatingMenu(refs.contextMenu, x, y);
}

function updateChatArchiveAction(chat = null) {
    if (!refs.chatArchiveAction) {
        return;
    }

    const label = refs.chatArchiveAction.querySelector("span");
    const icon = refs.chatArchiveAction.querySelector("i");
    const currentChat = chat || state.chats.find((item) => item.id === state.currentChatId) || null;

    if (!currentChat) {
        refs.chatArchiveAction.disabled = true;
        if (label) {
            label.textContent = "В архив";
        }
        if (icon) {
            icon.className = "fa-solid fa-box-archive";
        }
        return;
    }

    refs.chatArchiveAction.disabled = false;
    const isArchived = Boolean(currentChat.is_archived);

    if (label) {
        label.textContent = isArchived ? "Вернуть из архива" : "В архив";
    }

    if (icon) {
        icon.className = isArchived ? "fa-regular fa-folder-open" : "fa-solid fa-box-archive";
    }
}

function updateChatSearchAction(chat = null) {
    if (!refs.chatSearchAction) {
        return;
    }

    const currentChat = chat || state.chats.find((item) => item.id === state.currentChatId) || null;
    refs.chatSearchAction.disabled = !currentChat;
}

function updateChatTopAction(chat = null) {
    if (!refs.chatToTopAction) {
        return;
    }

    const currentChat = chat || state.chats.find((item) => item.id === state.currentChatId) || null;
    refs.chatToTopAction.disabled = !currentChat;
}

function updateChatDangerActions(chat = null) {
    const currentChat = chat || state.chats.find((item) => item.id === state.currentChatId) || null;
    if (refs.chatClearHistoryAction) {
        refs.chatClearHistoryAction.disabled = !currentChat;
    }
    if (refs.chatDeleteAction) {
        refs.chatDeleteAction.disabled = !currentChat;
    }
}

function openChatActionsMenu() {
    if (!refs.menuActionBtn || refs.menuActionBtn.disabled || !refs.chatActionsMenu) {
        return;
    }

    const currentChat = state.chats.find((item) => item.id === state.currentChatId) || null;
    updateChatArchiveAction(currentChat);
    updateChatSearchAction(currentChat);
    updateChatTopAction(currentChat);
    updateChatDangerActions(currentChat);

    const rect = refs.menuActionBtn.getBoundingClientRect();
    openFloatingMenu(refs.chatActionsMenu, rect.right, rect.bottom + 6);
}

function setSidebarOpen(next) {
    state.sidebarOpen = next;
    refs.appRoot.classList.toggle("sidebar-open", next);
}

function escapeHtml(text) {
    if (!text) {
        return "";
    }

    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatTime(isoString) {
    if (!isoString) {
        return "";
    }
    return new Date(isoString).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
    });
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

    return date.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
    });
}

function setThemeButtonIcon() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    const icon = refs.themeToggle.querySelector("i");

    if (!icon) {
        return;
    }

    if (currentTheme === "dark") {
        icon.className = "fa-regular fa-sun";
    } else {
        icon.className = "fa-regular fa-moon";
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";

    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setThemeButtonIcon();
}

function setChatHeader(chat) {
    const clearPinnedBanner = () => {
        refs.pinnedWrapper.classList.add("hidden");
        refs.pinnedWrapper.textContent = "";
        delete refs.pinnedWrapper.dataset.messageId;
        delete refs.pinnedWrapper.dataset.pinnedIndex;
        delete refs.pinnedWrapper.dataset.pinnedCount;
        refs.pinnedWrapper.removeAttribute("title");
    };

    const summarizePinnedMessage = (message) => {
        if (!message) {
            return "Вложение";
        }

        if (message.is_deleted) {
            return "Удаленное сообщение";
        }

        if (message.content && message.content.trim()) {
            return message.content;
        }

        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
            const first = message.attachments[0];
            if (first?.kind === "image") {
                return "Фото";
            }
            if (first?.kind === "video") {
                return "Видео";
            }
            if (first?.kind === "audio") {
                return "Аудио";
            }
            return "Файл";
        }

        return "Вложение";
    };

    if (!chat) {
        refs.chatAvatar.src = avatarFallback("Chat", true);
        refs.chatTitle.textContent = "Выберите чат";
        refs.chatSubtitle.textContent = "Найдите пользователя или создайте чат";
        if (refs.callActionBtn) {
            refs.callActionBtn.disabled = true;
        }
        if (refs.videoActionBtn) {
            refs.videoActionBtn.disabled = true;
        }
        if (refs.menuActionBtn) {
            refs.menuActionBtn.disabled = true;
        }
        updateChatArchiveAction(null);
        updateChatSearchAction(null);
        updateChatTopAction(null);
        updateChatDangerActions(null);
        closeChatActionsMenu();
        clearPinnedBanner();
        return;
    }

    if (refs.callActionBtn) {
        refs.callActionBtn.disabled = Boolean(chat.is_group);
    }
    if (refs.videoActionBtn) {
        refs.videoActionBtn.disabled = Boolean(chat.is_group);
    }
    if (refs.menuActionBtn) {
        refs.menuActionBtn.disabled = false;
    }
    updateChatArchiveAction(chat);
    updateChatSearchAction(chat);
    updateChatTopAction(chat);
    updateChatDangerActions(chat);
    refs.chatAvatar.src = chat.avatar_url || avatarFallback(chat.title, true);
    refs.chatTitle.textContent = chat.title || "Без названия";

    if (chat.is_group) {
        const onlineCount = (chat.members || []).filter((member) => member.is_online).length;
        refs.chatSubtitle.textContent = `${chat.member_count || 0} участников, онлайн: ${onlineCount}`;
    } else {
        refs.chatSubtitle.textContent = chat.online ? "в сети" : "не в сети";
    }

    const pinnedMessages = Array.isArray(chat.pinned_messages)
        ? chat.pinned_messages.filter((message) => message && Number.isInteger(Number(message.id)))
        : (chat.pinned_message ? [chat.pinned_message] : []);

    if (!pinnedMessages.length) {
        clearPinnedBanner();
        return;
    }

    const maxIndex = pinnedMessages.length - 1;
    const currentIndexRaw = Number(chat._activePinnedIndex);
    const currentIndex = Number.isInteger(currentIndexRaw) ? Math.min(Math.max(currentIndexRaw, 0), maxIndex) : 0;
    const currentPinned = pinnedMessages[currentIndex];

    chat._activePinnedIndex = currentIndex;

    refs.pinnedWrapper.classList.remove("hidden");
    refs.pinnedWrapper.textContent = `Закреплено ${currentIndex + 1}/${pinnedMessages.length}: ${summarizePinnedMessage(currentPinned)}`;
    refs.pinnedWrapper.dataset.messageId = String(currentPinned.id);
    refs.pinnedWrapper.dataset.pinnedIndex = String(currentIndex);
    refs.pinnedWrapper.dataset.pinnedCount = String(pinnedMessages.length);
    refs.pinnedWrapper.title = "Тап: следующий закреп • Зажмите, чтобы перейти к сообщению";
}

function setMessagesEmptyState(visible) {
    refs.chatEmpty.classList.toggle("hidden", !visible);
}

function setChatSkeleton(loading) {
    refs.chatListSkeleton.classList.toggle("hidden", !loading);
    refs.chatList.classList.toggle("hidden", loading);

    if (loading) {
        refs.chatListSkeleton.innerHTML = "";
        for (let i = 0; i < 7; i += 1) {
            const item = document.createElement("div");
            item.className = "skeleton";
            item.style.height = "64px";
            refs.chatListSkeleton.appendChild(item);
        }
    }
}

function setMessagesLoading(loading) {
    refs.messagesLoader.classList.toggle("hidden", !loading);

    if (loading) {
        refs.messagesLoader.innerHTML = "";
        for (let i = 0; i < 3; i += 1) {
            const item = document.createElement("div");
            item.className = "skeleton";
            item.style.height = "54px";
            refs.messagesLoader.appendChild(item);
        }
    }
}

function bindBaseEvents(app) {
    refs.logoutBtn.addEventListener("click", () => {
        window.AppStorage.clearAuth();
        window.location.href = "/login";
    });

    refs.themeToggle.addEventListener("click", toggleTheme);

    refs.mobileOpenSidebar.addEventListener("click", () => setSidebarOpen(true));
    refs.mobileCloseSidebar.addEventListener("click", () => setSidebarOpen(false));
    refs.voiceBtn?.addEventListener("click", () => {
        showToast("Запись голосовых скоро появится");
    });

    refs.menuActionBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = refs.chatActionsMenu && !refs.chatActionsMenu.classList.contains("hidden");
        if (isOpen) {
            closeChatActionsMenu();
        } else {
            openChatActionsMenu();
        }
    });
    refs.chatArchiveAction?.addEventListener("click", async () => {
        closeChatActionsMenu();
        if (!app.modules?.chats?.toggleArchiveForCurrentChat) {
            return;
        }
        await app.modules.chats.toggleArchiveForCurrentChat();
        const nextChat = app.modules.chats.getChatById(state.currentChatId);
        updateChatArchiveAction(nextChat || null);
    });
    refs.chatSearchAction?.addEventListener("click", () => {
        closeChatActionsMenu();
        if (!app.modules?.messages?.openSearchModal) {
            return;
        }
        try {
            app.modules.messages.openSearchModal();
        } catch (error) {
            console.error("Failed to open message search modal", error);
            showToast("Не удалось открыть поиск сообщений");
        }
    });
    refs.chatToTopAction?.addEventListener("click", async () => {
        closeChatActionsMenu();
        if (!app.modules?.messages?.scrollToChatStart) {
            return;
        }
        await app.modules.messages.scrollToChatStart();
    });
    refs.chatClearHistoryAction?.addEventListener("click", async () => {
        closeChatActionsMenu();
        if (!app.modules?.chats?.clearHistoryForCurrentChat) {
            return;
        }
        await app.modules.chats.clearHistoryForCurrentChat();
    });
    refs.chatDeleteAction?.addEventListener("click", async () => {
        closeChatActionsMenu();
        if (!app.modules?.chats?.deleteCurrentChat) {
            return;
        }
        await app.modules.chats.deleteCurrentChat();
    });

    refs.modalOverlay.addEventListener("click", (event) => {
        if (event.target === refs.modalOverlay) {
            hideModal();
        }
    });

    document.addEventListener("click", (event) => {
        if (!refs.contextMenu.contains(event.target)) {
            closeContextMenu();
        }
        if (
            refs.chatActionsMenu
            && !refs.chatActionsMenu.contains(event.target)
            && event.target !== refs.menuActionBtn
            && !refs.menuActionBtn?.contains(event.target)
        ) {
            closeChatActionsMenu();
        }

        if (!refs.searchResults.contains(event.target) && event.target !== refs.userSearch) {
            refs.searchResults.classList.add("hidden");
        }

        if (!refs.emojiPanel.contains(event.target) && event.target !== refs.emojiBtn) {
            refs.emojiPanel.classList.add("hidden");
        }

        if (
            state.sidebarOpen
            && !refs.sidebar.contains(event.target)
            && event.target !== refs.mobileOpenSidebar
            && !refs.mobileOpenSidebar.contains(event.target)
        ) {
            setSidebarOpen(false);
        }
    });

    window.addEventListener("resize", () => {
        closeChatActionsMenu();
        if (window.innerWidth > 900 && state.sidebarOpen) {
            setSidebarOpen(false);
        }
    });

    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener("message", (event) => {
            if (event.data?.type === "OPEN_CHAT" && event.data.chatId && app.modules?.chats) {
                app.modules.chats.openChat(Number(event.data.chatId));
            }
        });
    }
}

function renderMe(user) {
    refs.meAvatar.src = user.avatar_url || avatarFallback(user.display_name);
    refs.meName.textContent = user.display_name;
    refs.meUsername.textContent = `@${user.username}`;
}

async function boot() {
    if (!state.token) {
        return;
    }

    const app = {
        config: window.APP_CONFIG,
        api: window.Api,
        storage: window.AppStorage,
        refs,
        state,
        helpers: {
            avatarFallback,
            closeContextMenu,
            escapeHtml,
            formatTime,
            formatChatTime,
            hideModal,
            openContextMenu,
            renderMe,
            setChatHeader,
            setChatSkeleton,
            setMessagesEmptyState,
            setMessagesLoading,
            setSidebarOpen,
            showModal,
            showToast,
        },
        modules: {},
    };

    bindBaseEvents(app);
    setThemeButtonIcon();

    try {
        const meResponse = await app.api.me();
        app.state.me = meResponse.user;
        app.storage.setUser(meResponse.user);
        renderMe(meResponse.user);
    } catch (error) {
        app.storage.clearAuth();
        window.location.href = "/login";
        return;
    }

    const messages = initMessagesModule(app);
    const uploads = initUploadsModule(app);
    const chats = initChatsModule(app);
    const calls = initCallsModule(app);
    const socket = initSocketModule(app);

    app.modules.messages = messages;
    app.modules.uploads = uploads;
    app.modules.chats = chats;
    app.modules.calls = calls;
    app.modules.socket = socket;

    messages.attachDependencies({ chats, uploads });
    chats.attachDependencies({ messages });
    uploads.attachDependencies({ messages });
    calls.attachDependencies({ chats, socket });
    socket.attachDependencies({ chats, messages, calls });

    uploads.bindEvents();
    messages.bindEvents();
    chats.bindEvents();
    calls.bindEvents();

    app.helpers.setChatSkeleton(true);
    await chats.loadChats();
    app.helpers.setChatSkeleton(false);

    const queryChatId = Number(new URLSearchParams(window.location.search).get("chat"));
    if (queryChatId && Number.isInteger(queryChatId)) {
        await chats.openChat(queryChatId);
    } else if (app.state.chats.length > 0) {
        await chats.openChat(app.state.chats[0].id);
    } else {
        app.helpers.setChatHeader(null);
        app.helpers.setMessagesEmptyState(true);
    }

    socket.connect();
}

boot();
