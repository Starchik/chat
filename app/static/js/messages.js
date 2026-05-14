export function initMessagesModule(app) {
    const { api, refs, state, storage, helpers, config } = app;

    const deps = {
        chats: null,
        uploads: null,
    };

    let contextMessage = null;
    let typingTimeoutId = null;
    let notificationInit = false;
    let pinnedHoldTimer = null;
    let pinnedHoldTriggered = false;
    let glowMessageElement = null;
    let autoScrollEnabled = true;
    const lastReadByChat = new Map();

    function getCurrentChat() {
        return deps.chats?.getChatById(state.currentChatId) || null;
    }

    function getChatMessages(chatId) {
        return storage.getMessages(chatId) || [];
    }

    function setChatMessages(chatId, messages) {
        const maxCached = config.maxCachedMessages || 500;
        const sorted = [...messages].sort((left, right) => left.id - right.id);
        const tail = sorted.slice(-maxCached);
        storage.setMessages(chatId, tail);
        return tail;
    }

    function mergeMessages(chatId, incomingMessages) {
        const current = getChatMessages(chatId);
        const map = new Map(current.map((message) => [message.id, message]));

        incomingMessages.forEach((incoming) => {
            const existing = map.get(incoming.id);
            map.set(incoming.id, {
                ...(existing || {}),
                ...incoming,
            });
        });

        const merged = Array.from(map.values()).sort((left, right) => left.id - right.id);
        return setChatMessages(chatId, merged);
    }

    function ensureLazyState(chatId) {
        if (!state.lazyStateByChat[chatId]) {
            state.lazyStateByChat[chatId] = {
                hasMore: true,
                loading: false,
                nextBefore: null,
            };
        }

        return state.lazyStateByChat[chatId];
    }

    function autoResizeInput() {
        refs.messageInput.style.height = "auto";
        const maxHeight = 170;
        const minHeight = 44;
        const needsScroll = refs.messageInput.scrollHeight > maxHeight;
        const nextHeight = Math.min(refs.messageInput.scrollHeight, maxHeight);
        refs.messageInput.style.height = `${Math.max(nextHeight, minHeight)}px`;
        refs.messageInput.style.overflowY = needsScroll ? "auto" : "hidden";
    }

    function scrollToBottom(smooth = false) {
        autoScrollEnabled = true;
        refs.messagesScroll.scrollTo({
            top: refs.messagesScroll.scrollHeight,
            behavior: smooth ? "smooth" : "auto",
        });
    }

    function isNearBottom(threshold = 24) {
        return refs.messagesScroll.scrollHeight - refs.messagesScroll.scrollTop - refs.messagesScroll.clientHeight <= threshold;
    }

    function updateAutoScrollState() {
        autoScrollEnabled = isNearBottom();
    }

    function isChatVisibleForRead() {
        return document.visibilityState === "visible" && document.hasFocus();
    }

    function getLastMessageId(chatId) {
        const messages = getChatMessages(chatId);
        if (!messages.length) {
            return null;
        }

        const lastMessage = messages[messages.length - 1];
        return lastMessage?.id || null;
    }

    function messageTime(dateIso) {
        return helpers.formatTime(dateIso);
    }

    function findMessageById(chatId, messageId) {
        const messages = getChatMessages(chatId);
        return messages.find((message) => message.id === messageId) || null;
    }

    function resolveReplyText(message) {
        if (!message.reply_to_id) {
            return null;
        }

        if (message.reply_to?.content) {
            return message.reply_to.content;
        }

        if (message.reply_to?.attachments?.length) {
            return message.reply_to.attachments[0].kind === "image" ? "Фото" : "Файл";
        }

        const cached = findMessageById(message.chat_id, message.reply_to_id);
        if (!cached) {
            return "Сообщение";
        }

        if (cached.content) {
            return cached.content;
        }

        if (cached.attachments?.length) {
            return cached.attachments[0].kind === "image" ? "Фото" : "Файл";
        }

        return "Сообщение";
    }

    function resolveForwardedText(message) {
        if (!message.forwarded_from_message_id) {
            return null;
        }

        const forwardedSenderName = message.forwarded_from?.sender?.display_name
            || message.forwarded_from?.sender?.username;
        if (forwardedSenderName) {
            return `Переслано от ${forwardedSenderName}`;
        }

        const cachedForwarded = findMessageById(message.chat_id, message.forwarded_from_message_id);
        const cachedSenderName = cachedForwarded?.sender?.display_name
            || cachedForwarded?.sender?.username;
        if (cachedSenderName) {
            return `Переслано от ${cachedSenderName}`;
        }

        if (message.forwarded_from?.sender_id && message.forwarded_from.sender_id === state.me?.id) {
            return "Переслано от вас";
        }

        return "Пересланное сообщение";
    }

    function isMessagePinned(message) {
        if (!message) {
            return false;
        }
        const chat = getCurrentChat();
        return chat?.pinned_message?.id === message.id;
    }

    function updatePinActionLabel(message) {
        const pinButton = refs.contextMenu.querySelector('button[data-action="pin"]');
        if (!pinButton) {
            return;
        }
        const label = pinButton.querySelector("span");
        if (!label) {
            return;
        }

        label.textContent = isMessagePinned(message) ? "Открепить" : "Закрепить";
    }

    function renderAttachment(attachment) {
        const mediaKind = detectAttachmentKind(attachment);
        const fileName = helpers.escapeHtml(attachment.file_name || "Файл");
        const fileUrl = attachment.file_url || "#";
        const mime = helpers.escapeHtml(attachment.mime_type || "");

        if (mediaKind === "image") {
            return `
                <div class="message__file">
                    <a
                        href="${fileUrl}"
                        class="message__file-preview"
                        data-previewable="1"
                        data-kind="image"
                        data-url="${fileUrl}"
                        data-name="${fileName}"
                        data-mime="${mime}"
                    >
                        <img class="message__file-image" src="${fileUrl}" alt="${fileName}" loading="lazy" />
                    </a>
                </div>
            `;
        }

        if (mediaKind === "video") {
            return `
                <div class="message__file">
                    <a
                        class="message__file-doc message__file-doc--preview"
                        href="${fileUrl}"
                        data-previewable="1"
                        data-kind="video"
                        data-url="${fileUrl}"
                        data-name="${fileName}"
                        data-mime="${mime}"
                    >
                        <i class="fa-solid fa-film"></i>
                        <span>${fileName}</span>
                    </a>
                </div>
            `;
        }

        if (mediaKind === "audio") {
            return `
                <div class="message__file">
                    <a
                        class="message__file-doc message__file-doc--preview"
                        href="${fileUrl}"
                        data-previewable="1"
                        data-kind="audio"
                        data-url="${fileUrl}"
                        data-name="${fileName}"
                        data-mime="${mime}"
                    >
                        <i class="fa-solid fa-music"></i>
                        <span>${fileName}</span>
                    </a>
                </div>
            `;
        }

        return `
            <div class="message__file">
                <a class="message__file-doc" href="${fileUrl}" target="_blank" rel="noopener noreferrer">
                    <i class="fa-regular fa-file"></i>
                    <span>${fileName}</span>
                </a>
            </div>
        `;
    }

    function detectAttachmentKind(attachment) {
        if (!attachment) {
            return "file";
        }

        if (attachment.kind === "image") {
            return "image";
        }

        const mime = (attachment.mime_type || "").toLowerCase();
        const fileName = (attachment.file_name || "").toLowerCase();
        const extension = fileName.includes(".")
            ? fileName.split(".").pop()
            : "";

        if (mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(extension)) {
            return "video";
        }

        if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(extension)) {
            return "audio";
        }

        return "file";
    }

    function openAttachmentPreview({ kind, url, name, mimeType = "" }) {
        if (!url || !kind || kind === "file") {
            return;
        }

        const safeName = helpers.escapeHtml(name || "Файл");
        const safeUrl = helpers.escapeHtml(url);
        const safeMime = helpers.escapeHtml(mimeType);
        const isZoomable = kind === "image";

        let content = "";
        if (kind === "image") {
            content = `<img class="media-preview__image media-preview__zoom-target" src="${safeUrl}" alt="${safeName}" />`;
        } else if (kind === "video") {
            content = `
                <video class="media-preview__video" controls autoplay playsinline preload="metadata">
                    <source src="${safeUrl}" type="${safeMime}" />
                </video>
            `;
        } else if (kind === "audio") {
            content = `
                <div class="media-preview__audio-wrap">
                    <div class="media-preview__title">${safeName}</div>
                    <audio class="media-preview__audio" controls autoplay preload="metadata">
                        <source src="${safeUrl}" type="${safeMime}" />
                    </audio>
                </div>
            `;
        }

        helpers.showModal(`
            <div class="media-preview">
                <button id="media-preview-close" class="icon-btn media-preview__close" type="button" aria-label="Закрыть">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="media-preview__body${isZoomable ? " media-preview__body--zoomable" : ""}">
                    ${content}
                </div>
            </div>
        `, () => {
            const closeButton = document.getElementById("media-preview-close");
            refs.modal.classList.add("modal--media-preview");
            refs.modalOverlay?.classList.add("modal-overlay--media-preview");
            closeButton?.addEventListener("click", helpers.hideModal);

            if (!isZoomable) {
                return;
            }

            const zoomTarget = document.querySelector(".media-preview__zoom-target");
            const zoomBody = document.querySelector(".media-preview__body");

            if (!zoomTarget || !zoomBody) {
                return;
            }

            const minScale = 1;
            const maxScale = 4;
            const zoomStep = 0.2;
            let scale = 1;
            let baseWidth = 0;
            const isImageTarget = zoomTarget.tagName === "IMG";
            let pinchStartDistance = 0;
            let pinchStartScale = 1;

            let isDragging = false;
            let dragPointerId = null;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragStartScrollLeft = 0;
            let dragStartScrollTop = 0;

            const isPannable = () => {
                if (!isImageTarget || scale <= minScale + 0.001) {
                    return false;
                }

                return zoomBody.scrollWidth > zoomBody.clientWidth + 1 || zoomBody.scrollHeight > zoomBody.clientHeight + 1;
            };

            const stopDragging = () => {
                if (!isDragging) {
                    return;
                }

                isDragging = false;
                dragPointerId = null;
                zoomBody.classList.remove("media-preview__body--dragging");
            };

            const updatePanState = () => {
                const pannable = isPannable();
                zoomBody.classList.toggle("media-preview__body--draggable", pannable);
                if (!pannable) {
                    stopDragging();
                }
            };

            const setBaseWidth = () => {
                if (baseWidth > 0) {
                    return;
                }

                const rect = zoomTarget.getBoundingClientRect();
                if (rect.width > 0) {
                    baseWidth = rect.width;
                }
            };

            const applyZoom = () => {
                if (scale <= minScale + 0.001) {
                    zoomTarget.style.width = "";
                    zoomTarget.style.maxWidth = "";
                    zoomTarget.style.maxHeight = "";
                    zoomBody.scrollLeft = 0;
                    zoomBody.scrollTop = 0;
                    updatePanState();
                    return;
                }

                setBaseWidth();
                if (baseWidth <= 0) {
                    return;
                }

                zoomTarget.style.maxWidth = "none";
                zoomTarget.style.maxHeight = "none";
                zoomTarget.style.width = `${Math.round(baseWidth * scale)}px`;
                updatePanState();
            };

            const changeScale = (nextScale) => {
                scale = Math.min(maxScale, Math.max(minScale, nextScale));
                applyZoom();
            };

            zoomBody.addEventListener("wheel", (event) => {
                event.preventDefault();
                const direction = event.deltaY > 0 ? -zoomStep : zoomStep;
                changeScale(scale + direction);
            }, { passive: false });

            zoomTarget.addEventListener("dblclick", () => {
                if (scale <= 1.001) {
                    changeScale(2);
                } else {
                    changeScale(1);
                }
            });

            if (isImageTarget) {
                const getTouchDistance = (touches) => {
                    if (!touches || touches.length < 2) {
                        return 0;
                    }

                    const dx = touches[0].clientX - touches[1].clientX;
                    const dy = touches[0].clientY - touches[1].clientY;
                    return Math.hypot(dx, dy);
                };

                const beginPinch = (event) => {
                    if (event.touches.length !== 2) {
                        return;
                    }
                    const distance = getTouchDistance(event.touches);
                    if (distance <= 0) {
                        return;
                    }
                    pinchStartDistance = distance;
                    pinchStartScale = scale;
                };

                zoomBody.addEventListener("touchstart", (event) => {
                    if (event.touches.length === 2) {
                        beginPinch(event);
                        event.preventDefault();
                    }
                }, { passive: false });

                zoomBody.addEventListener("touchmove", (event) => {
                    if (event.touches.length !== 2 || pinchStartDistance <= 0) {
                        return;
                    }
                    const distance = getTouchDistance(event.touches);
                    if (distance <= 0) {
                        return;
                    }
                    const factor = distance / pinchStartDistance;
                    changeScale(pinchStartScale * factor);
                    event.preventDefault();
                }, { passive: false });

                zoomBody.addEventListener("touchend", (event) => {
                    if (event.touches.length >= 2) {
                        return;
                    }
                    pinchStartDistance = 0;
                });

                zoomBody.addEventListener("touchcancel", () => {
                    pinchStartDistance = 0;
                });

                zoomBody.addEventListener("gesturestart", (event) => {
                    event.preventDefault();
                });
                zoomBody.addEventListener("gesturechange", (event) => {
                    event.preventDefault();
                });
                zoomBody.addEventListener("gestureend", (event) => {
                    event.preventDefault();
                });

                zoomTarget.draggable = false;
                zoomTarget.addEventListener("dragstart", (event) => {
                    event.preventDefault();
                });

                zoomBody.addEventListener("pointerdown", (event) => {
                    if (event.button !== 0 || !isPannable()) {
                        return;
                    }

                    isDragging = true;
                    dragPointerId = event.pointerId;
                    dragStartX = event.clientX;
                    dragStartY = event.clientY;
                    dragStartScrollLeft = zoomBody.scrollLeft;
                    dragStartScrollTop = zoomBody.scrollTop;

                    if (typeof zoomBody.setPointerCapture === "function") {
                        zoomBody.setPointerCapture(event.pointerId);
                    }

                    zoomBody.classList.add("media-preview__body--dragging");
                    event.preventDefault();
                });

                zoomBody.addEventListener("pointermove", (event) => {
                    if (!isDragging || dragPointerId !== event.pointerId) {
                        return;
                    }

                    const deltaX = event.clientX - dragStartX;
                    const deltaY = event.clientY - dragStartY;
                    zoomBody.scrollLeft = dragStartScrollLeft - deltaX;
                    zoomBody.scrollTop = dragStartScrollTop - deltaY;
                    event.preventDefault();
                });

                zoomBody.addEventListener("pointerup", (event) => {
                    if (dragPointerId !== event.pointerId) {
                        return;
                    }

                    stopDragging();
                    if (typeof zoomBody.releasePointerCapture === "function") {
                        zoomBody.releasePointerCapture(event.pointerId);
                    }
                });

                zoomBody.addEventListener("pointercancel", stopDragging);
                zoomBody.addEventListener("lostpointercapture", stopDragging);
            }

            if (zoomTarget.tagName === "IMG") {
                zoomTarget.addEventListener("load", () => {
                    baseWidth = 0;
                    setBaseWidth();
                    applyZoom();
                }, { once: true });
            }

            setBaseWidth();
            updatePanState();
        });
    }

    function getReadState(message) {
        const readBy = message.read_by || [];
        const hasReadByOthers = readBy.some((entry) => entry.user_id !== state.me.id);

        if (hasReadByOthers) {
            return '<i class="fa-solid fa-check-double"></i>';
        }

        return '<i class="fa-solid fa-check"></i>';
    }

    function normalizeReactions(rawReactions) {
        if (!Array.isArray(rawReactions) || rawReactions.length === 0) {
            return [];
        }

        const map = new Map();

        rawReactions.forEach((item) => {
            let emoji = "";
            let count = 1;
            let fromMe = false;

            if (typeof item === "string") {
                emoji = item.trim();
            } else if (item && typeof item === "object") {
                emoji = String(item.emoji || item.reaction || item.value || "").trim();
                if (Number.isFinite(Number(item.count)) && Number(item.count) > 0) {
                    count = Number(item.count);
                } else if (Array.isArray(item.user_ids) && item.user_ids.length > 0) {
                    count = item.user_ids.length;
                }
                fromMe = Boolean(
                    item.me
                    || item.is_me
                    || (Array.isArray(item.user_ids) && item.user_ids.includes(state.me?.id)),
                );
            }

            if (!emoji) {
                return;
            }

            const previous = map.get(emoji);
            if (previous) {
                previous.count += count;
                previous.fromMe = previous.fromMe || fromMe;
                return;
            }

            map.set(emoji, {
                emoji,
                count,
                fromMe,
            });
        });

        return Array.from(map.values());
    }

    function createReactionsElement(rawReactions) {
        const reactions = normalizeReactions(rawReactions);
        if (!reactions.length) {
            return null;
        }

        const wrap = document.createElement("div");
        wrap.className = "message__reactions";

        reactions.forEach((reaction) => {
            const chip = document.createElement("span");
            chip.className = `message__reaction ${reaction.fromMe ? "message__reaction--mine" : ""}`;

            const emoji = document.createElement("span");
            emoji.textContent = reaction.emoji;

            const count = document.createElement("strong");
            count.textContent = String(reaction.count);

            chip.append(emoji, count);
            wrap.appendChild(chip);
        });

        return wrap;
    }

    function getDateSeparatorKey(isoString) {
        if (!isoString) {
            return "";
        }
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
            return "";
        }
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function formatDateSeparatorLabel(isoString) {
        if (!isoString) {
            return "";
        }

        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
            return "";
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

        if (diffDays === 0) {
            return "Сегодня";
        }
        if (diffDays === -1) {
            return "Вчера";
        }

        return date.toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
    }

    function createDateSeparator(isoString) {
        const divider = document.createElement("div");
        divider.className = "date-separator";
        divider.innerHTML = `<span>${formatDateSeparatorLabel(isoString)}</span>`;
        return divider;
    }

    function createMessageElement(message, previousMessage = null) {
        const isMine = message.sender_id === state.me.id;
        const isDeleted = Boolean(message.is_deleted);

        const row = document.createElement("div");
        row.className = `message-row ${isMine ? "message-row--mine" : "message-row--other"}`;

        if (previousMessage) {
            const closeBySender = previousMessage.sender_id === message.sender_id;
            const closeByTime = Math.abs(new Date(previousMessage.created_at).getTime() - new Date(message.created_at).getTime()) < 4 * 60 * 1000;
            if (closeBySender && closeByTime) {
                row.classList.add("message-row--grouped");
            }
        }

        const bubble = document.createElement("article");
        bubble.className = `message ${isMine ? "message--mine" : "message--other"} ${isDeleted ? "message--deleted" : ""}`;
        bubble.dataset.messageId = String(message.id);

        const chat = getCurrentChat();
        if (!isMine && chat?.is_group && !row.classList.contains("message-row--grouped")) {
            const top = document.createElement("div");
            top.className = "message__top";

            const author = document.createElement("div");
            author.className = "message__author";
            author.textContent = message.sender?.display_name || "Пользователь";

            top.append(author);
            bubble.appendChild(top);
        }

        const replyText = resolveReplyText(message);
        if (replyText) {
            const reply = document.createElement("div");
            reply.className = "message__reply";
            reply.textContent = replyText;
            bubble.appendChild(reply);
        }

        const forwardedText = resolveForwardedText(message);
        if (forwardedText) {
            const forwarded = document.createElement("div");
            forwarded.className = "message__forwarded";
            forwarded.textContent = forwardedText;
            bubble.appendChild(forwarded);
        }

        const content = document.createElement("div");
        content.className = "message__content";
        content.textContent = isDeleted ? "Сообщение удалено" : (message.content || "");
        bubble.appendChild(content);

        if (!isDeleted && message.attachments?.length) {
            const files = document.createElement("div");
            files.className = "message__files";
            files.innerHTML = message.attachments.map(renderAttachment).join("");
            bubble.appendChild(files);
        }

        const reactions = createReactionsElement(message.reactions);
        if (reactions) {
            bubble.appendChild(reactions);
        }

        const meta = document.createElement("div");
        meta.className = "message__meta";

        if (message.is_edited) {
            const edited = document.createElement("span");
            edited.className = "message__edited";
            edited.textContent = "изменено";
            meta.appendChild(edited);
        }

        const time = document.createElement("span");
        time.textContent = messageTime(message.created_at);
        meta.appendChild(time);

        if (isMine) {
            const read = document.createElement("span");
            read.className = "message__read";
            read.innerHTML = getReadState(message);
            meta.appendChild(read);
        }

        bubble.appendChild(meta);

        bubble.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            contextMessage = message;
            setupContextMenuState(message);
            helpers.openContextMenu(event.clientX, event.clientY);
        });

        row.appendChild(bubble);
        return row;
    }

    function renderTypingIndicator() {
        const chatId = state.currentChatId;
        if (!chatId) {
            refs.typingIndicator.classList.add("hidden");
            return;
        }

        const typingUsers = state.typingUsersByChat.get(chatId);
        if (!typingUsers || typingUsers.size === 0) {
            refs.typingIndicator.classList.add("hidden");
            refs.typingIndicator.textContent = "";
            return;
        }

        const chat = getCurrentChat();
        const names = [];

        typingUsers.forEach((userId) => {
            const member = chat?.members?.find((item) => item.id === userId);
            names.push(member?.display_name || "Кто-то");
        });

        refs.typingIndicator.classList.remove("hidden");

        if (names.length === 1) {
            refs.typingIndicator.textContent = `${names[0]} печатает...`;
        } else {
            refs.typingIndicator.textContent = `${names.slice(0, 3).join(", ")} печатают...`;
        }
    }

    function renderMessages(chatId) {
        const messages = getChatMessages(chatId).filter((message) => !message?.is_deleted);
        refs.messagesList.innerHTML = "";

        let previousMessage = null;
        let previousDateKey = "";
        messages.forEach((message) => {
            const dateKey = getDateSeparatorKey(message.created_at);
            if (dateKey && dateKey !== previousDateKey) {
                refs.messagesList.appendChild(createDateSeparator(message.created_at));
                previousDateKey = dateKey;
            }

            const node = createMessageElement(message, previousMessage);
            refs.messagesList.appendChild(node);
            previousMessage = message;
        });

        helpers.setMessagesEmptyState(messages.length === 0);
        renderTypingIndicator();
    }

    function setReplyPreview(message) {
        state.replyToMessage = message;
        state.editingMessageId = null;

        if (!message) {
            refs.replyPreview.classList.add("hidden");
            refs.replyPreview.innerHTML = "";
            return;
        }

        refs.replyPreview.classList.remove("hidden");
        refs.replyPreview.innerHTML = `
            <div class="reply-preview__meta">
                <span class="reply-preview__title">Ответ на сообщение</span>
                <span class="reply-preview__text">${helpers.escapeHtml(message.content || "Вложение")}</span>
            </div>
            <button id="reply-cancel-btn" class="icon-btn" type="button" aria-label="Отменить">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;

        const cancelButton = document.getElementById("reply-cancel-btn");
        cancelButton.addEventListener("click", () => {
            setReplyPreview(null);
        });
    }

    function setEditMode(message) {
        state.replyToMessage = null;
        state.editingMessageId = message.id;

        refs.replyPreview.classList.remove("hidden");
        refs.replyPreview.innerHTML = `
            <div class="reply-preview__meta">
                <span class="reply-preview__title">Редактирование сообщения</span>
                <span class="reply-preview__text">ID: ${message.id}</span>
            </div>
            <button id="edit-cancel-btn" class="icon-btn" type="button" aria-label="Отменить">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;

        refs.messageInput.value = message.content || "";
        refs.messageInput.focus();
        autoResizeInput();

        const cancelButton = document.getElementById("edit-cancel-btn");
        cancelButton.addEventListener("click", clearComposerState);
    }

    function clearComposerState() {
        state.replyToMessage = null;
        state.editingMessageId = null;
        refs.replyPreview.classList.add("hidden");
        refs.replyPreview.innerHTML = "";
    }

    function setupContextMenuState(message) {
        const isMine = message.sender_id === state.me.id;
        const isDeleted = Boolean(message.is_deleted);

        refs.contextMenu.querySelectorAll("button[data-action]").forEach((button) => {
            const action = button.dataset.action;

            if (action === "edit" || action === "delete") {
                button.style.display = isMine && !isDeleted ? "flex" : "none";
                return;
            }

            if (isDeleted && action === "reply") {
                button.style.display = "none";
                return;
            }

            button.style.display = "flex";
        });

        updatePinActionLabel(message);
    }

    async function jumpToMessage(messageId) {
        const chatId = state.currentChatId;
        if (!chatId || !messageId) {
            return false;
        }

        const targetSelector = `[data-message-id="${messageId}"]`;
        let target = refs.messagesList.querySelector(targetSelector);
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.add("message--jump-highlight");
            window.setTimeout(() => target.classList.remove("message--jump-highlight"), 1200);
            return true;
        }

        const lazyState = ensureLazyState(chatId);
        let attempts = 0;
        while (lazyState.hasMore && attempts < 30) {
            const messages = getChatMessages(chatId);
            if (!messages.length) {
                break;
            }

            const oldestMessage = messages[0];
            await loadMessages(chatId, {
                before: oldestMessage.id,
                appendToTop: true,
            });

            target = refs.messagesList.querySelector(targetSelector);
            if (target) {
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                target.classList.add("message--jump-highlight");
                window.setTimeout(() => target.classList.remove("message--jump-highlight"), 1200);
                return true;
            }

            attempts += 1;
        }

        return false;
    }

    async function jumpToPinnedMessage() {
        const rawId = refs.pinnedWrapper.dataset.messageId;
        const messageId = Number(rawId);
        if (!messageId || !Number.isInteger(messageId)) {
            return;
        }

        const found = await jumpToMessage(messageId);
        if (!found) {
            helpers.showToast("Не удалось найти закрепленное сообщение");
        }
    }

    function ensureNotificationPermissionOnInteraction() {
        if (notificationInit || !("Notification" in window)) {
            return;
        }
        notificationInit = true;

        const requestPermission = () => {
            document.removeEventListener("click", requestPermission);
            document.removeEventListener("keydown", requestPermission);
            document.removeEventListener("touchstart", requestPermission);

            if (Notification.permission === "default") {
                Notification.requestPermission().catch(() => {});
            }
        };

        document.addEventListener("click", requestPermission, { once: true });
        document.addEventListener("keydown", requestPermission, { once: true });
        document.addEventListener("touchstart", requestPermission, { once: true });
    }

    function maybeNotify(message) {
        if (!message || message.sender_id === state.me.id) {
            return;
        }
        if (!("Notification" in window)) {
            return;
        }
        if (Notification.permission !== "granted") {
            return;
        }
        if (document.visibilityState === "visible" && state.currentChatId === message.chat_id) {
            return;
        }

        const chat = deps.chats.getChatById(message.chat_id);
        if (!chat) {
            return;
        }

        const text = message.content || (message.attachments?.length ? "Вложение" : "Новое сообщение");
        const notification = new Notification(chat.title || "Новое сообщение", {
            body: text.slice(0, 120),
            icon: chat.avatar_url || "/static/icons/icon-192.svg",
            tag: `chat-${chat.id}`,
            renotify: true,
        });

        notification.onclick = () => {
            window.focus();
            void deps.chats.openChat(chat.id);
            notification.close();
        };
    }

    function openForwardModal(messageId) {
        const availableChats = state.chats.filter((chat) => chat.id !== state.currentChatId);

        if (!availableChats.length) {
            helpers.showToast("Нет доступных чатов для пересылки");
            return;
        }

        helpers.showModal(`
            <h3>Переслать сообщение</h3>
            <select id="forward-chat-select">
                ${availableChats.map((chat) => (
                    `<option value="${chat.id}">${helpers.escapeHtml(chat.title || "Без названия")}</option>`
                )).join("")}
            </select>
            <div class="modal-actions">
                <button id="forward-cancel-btn" class="btn btn-soft" type="button">Отмена</button>
                <button id="forward-send-btn" class="btn btn-primary" type="button">Переслать</button>
            </div>
        `, () => {
            const cancelButton = document.getElementById("forward-cancel-btn");
            const sendButton = document.getElementById("forward-send-btn");

            cancelButton.addEventListener("click", helpers.hideModal);
            sendButton.addEventListener("click", async () => {
                const select = document.getElementById("forward-chat-select");
                const targetChatId = Number(select.value);

                if (!targetChatId) {
                    return;
                }

                sendButton.disabled = true;
                try {
                    await api.forwardMessage(messageId, targetChatId);
                    helpers.hideModal();
                    helpers.showToast("Сообщение переслано");
                } catch (error) {
                    helpers.showToast(error.message || "Не удалось переслать сообщение");
                } finally {
                    sendButton.disabled = false;
                }
            });
        });
    }

    async function sendMessage() {
        if (!state.currentChatId) {
            helpers.showToast("Сначала выберите чат");
            return;
        }

        const content = refs.messageInput.value.trim();
        const files = deps.uploads ? deps.uploads.getFiles() : [];
        const shouldUploadFiles = !state.editingMessageId && files.length > 0;

        if (!content && files.length === 0) {
            return;
        }

        refs.sendBtn.disabled = true;
        let currentUploadingFile = null;
        if (deps.uploads && shouldUploadFiles) {
            deps.uploads.beginUpload(files);
            deps.uploads.setUploadLocked(true);
        }

        try {
            if (state.editingMessageId) {
                const editResponse = await api.editMessage(state.editingMessageId, content);
                if (!app.modules.socket?.isConnected()) {
                    onMessageUpdated(editResponse.message);
                }
                helpers.showToast("Сообщение обновлено");
            } else {
                const sendResponse = await api.sendMessage({
                    chatId: state.currentChatId,
                    content,
                    replyToId: state.replyToMessage?.id || null,
                    files,
                    onUploadProgress: (progress) => {
                        currentUploadingFile = progress.file || currentUploadingFile;
                        deps.uploads?.updateUploadProgress(progress);
                    },
                });
                if (deps.uploads && shouldUploadFiles) {
                    files.forEach((file) => deps.uploads.finishUpload(file));
                }
                if (!app.modules.socket?.isConnected()) {
                    onIncomingMessage(sendResponse.message);
                }
            }

            refs.messageInput.value = "";
            autoResizeInput();
            clearComposerState();

            if (deps.uploads) {
                deps.uploads.clearFiles();
            }

            if (app.modules.socket) {
                app.modules.socket.sendTyping(state.currentChatId, false);
            }
        } catch (error) {
            if (deps.uploads && shouldUploadFiles) {
                if (currentUploadingFile) {
                    deps.uploads.failUpload(currentUploadingFile, error.message || "Ошибка загрузки");
                } else {
                    files.forEach((file) => deps.uploads.failUpload(file, error.message || "Ошибка загрузки"));
                }
            }
            helpers.showToast(error.message || "Не удалось отправить сообщение");
        } finally {
            if (shouldUploadFiles) {
                deps.uploads?.setUploadLocked(false);
            }
            refs.sendBtn.disabled = false;
        }
    }

    async function markRead(chatId, messageId = null) {
        const normalizedChatId = Number(chatId);
        if (!normalizedChatId || !isChatVisibleForRead()) {
            return false;
        }

        const requestedMessageId = Number(messageId);
        const targetMessageId = Number.isInteger(requestedMessageId) && requestedMessageId > 0
            ? requestedMessageId
            : getLastMessageId(normalizedChatId);

        if (!targetMessageId) {
            return false;
        }

        const lastReadId = lastReadByChat.get(normalizedChatId) || 0;
        if (targetMessageId <= lastReadId) {
            if (state.currentChatId === normalizedChatId) {
                deps.chats.markCurrentChatRead(targetMessageId);
            }
            return false;
        }

        try {
            await api.markChatRead(normalizedChatId, targetMessageId);
            if (app.modules.socket) {
                app.modules.socket.readMessages(normalizedChatId, targetMessageId);
            }
            lastReadByChat.set(normalizedChatId, targetMessageId);
            if (state.currentChatId === normalizedChatId) {
                deps.chats.markCurrentChatRead(targetMessageId);
            }
            return true;
        } catch (error) {
            console.warn("mark read failed", error);
            return false;
        }
    }

    function syncCurrentChatRead() {
        const chatId = state.currentChatId;
        if (!chatId || !isChatVisibleForRead()) {
            return;
        }

        const lastMessageId = getLastMessageId(chatId);
        if (!lastMessageId) {
            return;
        }

        void markRead(chatId, lastMessageId);
    }

    async function loadMessages(chatId, { before = null, appendToTop = false } = {}) {
        const lazyState = ensureLazyState(chatId);

        if (lazyState.loading) {
            return;
        }

        lazyState.loading = true;

        const previousScrollHeight = refs.messagesScroll.scrollHeight;
        const previousScrollTop = refs.messagesScroll.scrollTop;

        try {
            if (!appendToTop) {
                helpers.setMessagesLoading(true);
            }

            const response = await api.getMessages(chatId, before, config.messagePageSize || 30);
            const messages = response.messages || [];

            mergeMessages(chatId, messages);
            lazyState.hasMore = Boolean(response.has_more);
            lazyState.nextBefore = response.next_before;

            renderMessages(chatId);

            if (!appendToTop) {
                scrollToBottom(false);
            } else {
                const newScrollHeight = refs.messagesScroll.scrollHeight;
                refs.messagesScroll.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
            }

            const allMessages = getChatMessages(chatId);
            if (allMessages.length) {
                const lastMessage = allMessages[allMessages.length - 1];
                await markRead(chatId, lastMessage.id);
            }
        } catch (error) {
            helpers.showToast(error.message || "Не удалось загрузить сообщения");
        } finally {
            lazyState.loading = false;
            helpers.setMessagesLoading(false);
        }
    }

    async function openChat(chatId, chat) {
        const cachedMessages = getChatMessages(chatId);

        refs.messagesList.innerHTML = "";
        helpers.setMessagesEmptyState(cachedMessages.length === 0);

        if (cachedMessages.length) {
            renderMessages(chatId);
            scrollToBottom(false);
        }

        clearComposerState();
        refs.messageInput.value = "";
        autoResizeInput();

        ensureLazyState(chatId);

        await loadMessages(chatId, { before: null, appendToTop: false });

        if (chat?.last_message?.id) {
            await markRead(chatId, chat.last_message.id);
        }
    }

    function onIncomingMessage(message) {
        if (!message?.id) {
            return;
        }

        mergeMessages(message.chat_id, [message]);
        deps.chats.touchChatFromMessage(message);

        if (state.currentChatId === message.chat_id) {
            const shouldScroll = autoScrollEnabled || message.sender_id === state.me.id;
            renderMessages(message.chat_id);

            if (shouldScroll) {
                scrollToBottom(true);
            }

            if (message.sender_id !== state.me.id && isChatVisibleForRead()) {
                void markRead(message.chat_id, message.id);
            }

            if (message.sender_id === state.me.id && isChatVisibleForRead()) {
                deps.chats.markCurrentChatRead(message.id);
            }
        } else if (message.sender_id !== state.me.id) {
            const chat = deps.chats.getChatById(message.chat_id);
            if (chat) {
                helpers.showToast(`Новое сообщение: ${chat.title}`);
            }
        }

        maybeNotify(message);
    }

    function onMessageUpdated(message) {
        if (!message?.id) {
            return;
        }

        mergeMessages(message.chat_id, [message]);

        if (state.currentChatId === message.chat_id) {
            renderMessages(message.chat_id);
        }
    }

    function onMessageDeleted(payload) {
        const chatId = payload?.chat_id;
        const messageId = payload?.message_id;

        if (!chatId || !messageId) {
            return;
        }

        const messages = getChatMessages(chatId);
        const nextMessages = messages.filter((item) => item.id !== messageId);

        setChatMessages(chatId, nextMessages);

        if (state.currentChatId === chatId) {
            renderMessages(chatId);
        }
    }

    function onMessagePinned(payload) {
        const chatId = payload?.message?.chat_id;
        if (!chatId) {
            return;
        }

        const chat = deps.chats.getChatById(chatId);
        if (!chat) {
            return;
        }

        chat.pinned_message = payload.message;
        deps.chats.upsertChat(chat);

        if (state.currentChatId === chatId) {
            helpers.setChatHeader(chat);
        }
    }

    function onMessageUnpinned(payload) {
        const chatId = payload?.chat_id || state.currentChatId;
        const chat = deps.chats.getChatById(chatId);
        if (!chat || !payload?.message_id) {
            return;
        }

        if (chat.pinned_message?.id === payload.message_id) {
            chat.pinned_message = null;
            deps.chats.upsertChat(chat);
            helpers.setChatHeader(chat);
        }
    }

    function onMessagesRead(payload) {
        const chatId = payload?.chat_id;
        const userId = payload?.user_id;
        const lastReadId = payload?.last_read_message_id;

        if (!chatId || !userId || !lastReadId) {
            return;
        }

        const messages = getChatMessages(chatId);
        const nextMessages = messages.map((message) => {
            if (message.id > lastReadId) {
                return message;
            }

            const readBy = message.read_by || [];
            if (readBy.some((entry) => entry.user_id === userId)) {
                return message;
            }

            return {
                ...message,
                read_by: [...readBy, { user_id: userId }],
            };
        });

        setChatMessages(chatId, nextMessages);

        if (state.currentChatId === chatId) {
            renderMessages(chatId);
        }
    }

    function onTypingPayload(payload) {
        if (!payload?.chat_id || !payload?.user_id) {
            return;
        }

        const chatId = payload.chat_id;
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
    }

    async function handleScrollTopLoad() {
        const chatId = state.currentChatId;
        if (!chatId) {
            return;
        }

        const lazyState = ensureLazyState(chatId);
        if (!lazyState.hasMore || lazyState.loading) {
            return;
        }

        if (refs.messagesScroll.scrollTop > 90) {
            return;
        }

        const messages = getChatMessages(chatId);
        if (!messages.length) {
            return;
        }

        const oldestMessage = messages[0];
        await loadMessages(chatId, {
            before: oldestMessage.id,
            appendToTop: true,
        });
    }

    function handleInputTyping() {
        autoResizeInput();

        if (!state.currentChatId || !app.modules.socket) {
            return;
        }

        app.modules.socket.sendTyping(state.currentChatId, true);
        window.clearTimeout(typingTimeoutId);
        typingTimeoutId = window.setTimeout(() => {
            if (state.currentChatId) {
                app.modules.socket.sendTyping(state.currentChatId, false);
            }
        }, 1200);
    }

    function clearMessageCursorGlow() {
        if (!glowMessageElement) {
            return;
        }
        glowMessageElement.classList.remove("message--glow-active");
        glowMessageElement = null;
    }

    function handleMessageCursorGlow(event) {
        const bubble = event.target.closest(".message");
        if (!bubble || !refs.messagesList.contains(bubble)) {
            clearMessageCursorGlow();
            return;
        }

        const rect = bubble.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        bubble.style.setProperty("--glow-x", `${x}px`);
        bubble.style.setProperty("--glow-y", `${y}px`);

        if (glowMessageElement && glowMessageElement !== bubble) {
            glowMessageElement.classList.remove("message--glow-active");
        }

        bubble.classList.add("message--glow-active");
        glowMessageElement = bubble;
    }

    function handleKeyboardShortcuts(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            event.preventDefault();
            void sendMessage();
            return;
        }

        if (event.key === "Escape") {
            clearComposerState();
        }
    }

    function bindContextMenuActions() {
        refs.contextMenu.addEventListener("click", async (event) => {
            const button = event.target.closest("button[data-action]");
            if (!button || !contextMessage) {
                return;
            }

            helpers.closeContextMenu();

            const action = button.dataset.action;
            const message = contextMessage;
            contextMessage = null;

            if (action === "reply") {
                setReplyPreview(message);
                return;
            }

            if (action === "edit") {
                setEditMode(message);
                return;
            }

            if (action === "forward") {
                openForwardModal(message.id);
                return;
            }

            if (action === "pin") {
                try {
                    if (isMessagePinned(message)) {
                        const result = await api.unpinMessage(message.id);
                        onMessageUnpinned({
                            ...result,
                            chat_id: message.chat_id,
                        });
                        helpers.showToast("Сообщение откреплено");
                    } else {
                        const result = await api.pinMessage(message.id);
                        onMessagePinned(result);
                        helpers.showToast("Сообщение закреплено");
                    }
                } catch (error) {
                    helpers.showToast(error.message || "Не удалось изменить закреп");
                }
                return;
            }

            if (action === "delete") {
                try {
                    const result = await api.deleteMessage(message.id);
                    if (!app.modules.socket?.isConnected()) {
                        onMessageDeleted(result);
                    }
                    helpers.showToast("Сообщение удалено");
                } catch (error) {
                    helpers.showToast(error.message || "Не удалось удалить сообщение");
                }
            }
        });
    }

    function bindEmojiPanel() {
        refs.emojiPanel.innerHTML = "";

        (config.emojiList || []).forEach((emoji) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "emoji-item";
            item.textContent = emoji;
            item.addEventListener("click", () => {
                refs.messageInput.value += emoji;
                refs.messageInput.focus();
                autoResizeInput();
            });
            refs.emojiPanel.appendChild(item);
        });

        refs.emojiBtn.addEventListener("click", () => {
            refs.emojiPanel.classList.toggle("hidden");
        });
    }

    function bindEvents() {
        refs.messageInput.placeholder = "Введите сообщение...";

        refs.sendBtn.addEventListener("click", () => {
            void sendMessage();
        });

        refs.messageInput.addEventListener("input", handleInputTyping);
        refs.messageInput.addEventListener("keydown", handleKeyboardShortcuts);

        refs.messagesScroll.addEventListener("scroll", () => {
            updateAutoScrollState();
            void handleScrollTopLoad();
        });

        refs.messagesList.addEventListener("pointermove", handleMessageCursorGlow);
        refs.messagesList.addEventListener("pointerleave", clearMessageCursorGlow);
        refs.messagesList.addEventListener("pointercancel", clearMessageCursorGlow);

        refs.messagesList.addEventListener("click", (event) => {
            const previewTarget = event.target.closest("[data-previewable='1']");
            if (!previewTarget) {
                return;
            }

            event.preventDefault();

            openAttachmentPreview({
                kind: previewTarget.dataset.kind,
                url: previewTarget.dataset.url,
                name: previewTarget.dataset.name,
                mimeType: previewTarget.dataset.mime,
            });
        });

        refs.pinnedWrapper.addEventListener("pointerdown", () => {
            if (!refs.pinnedWrapper.dataset.messageId) {
                return;
            }

            pinnedHoldTriggered = false;
            window.clearTimeout(pinnedHoldTimer);
            pinnedHoldTimer = window.setTimeout(async () => {
                pinnedHoldTriggered = true;
                await jumpToPinnedMessage();
            }, 420);
        });

        const cancelPinnedHold = () => {
            window.clearTimeout(pinnedHoldTimer);
            pinnedHoldTimer = null;
        };

        refs.pinnedWrapper.addEventListener("pointerup", cancelPinnedHold);
        refs.pinnedWrapper.addEventListener("pointerleave", cancelPinnedHold);
        refs.pinnedWrapper.addEventListener("pointercancel", cancelPinnedHold);
        refs.pinnedWrapper.addEventListener("click", (event) => {
            if (pinnedHoldTriggered) {
                event.preventDefault();
                event.stopPropagation();
                pinnedHoldTriggered = false;
            }
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                syncCurrentChatRead();
            }
        });
        window.addEventListener("focus", syncCurrentChatRead);

        bindContextMenuActions();
        bindEmojiPanel();
        autoResizeInput();
        updateAutoScrollState();
        ensureNotificationPermissionOnInteraction();
    }

    function attachDependencies(nextDeps) {
        deps.chats = nextDeps.chats;
        deps.uploads = nextDeps.uploads;
    }

    return {
        attachDependencies,
        bindEvents,
        openChat,
        onIncomingMessage,
        onMessageUpdated,
        onMessageDeleted,
        onMessagePinned,
        onMessageUnpinned,
        onMessagesRead,
        onTypingPayload,
        renderTypingIndicator,
    };
}
