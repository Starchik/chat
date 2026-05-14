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
    const MAX_IMAGE_ATTACHMENT_GROUP_SIZE = 10;

    function getCurrentChat() {
        return deps.chats?.getChatById(state.currentChatId) || null;
    }

    function getPinnedMessages(chat = getCurrentChat()) {
        if (!chat) {
            return [];
        }

        const fromList = Array.isArray(chat.pinned_messages)
            ? chat.pinned_messages.filter((message) => message && Number.isInteger(Number(message.id)))
            : [];

        if (fromList.length) {
            return fromList;
        }

        if (chat.pinned_message && Number.isInteger(Number(chat.pinned_message.id))) {
            return [chat.pinned_message];
        }

        return [];
    }

    function applyPinnedMessages(chat, messages, preferredMessageId = null) {
        if (!chat) {
            return [];
        }

        const unique = [];
        const seen = new Set();
        (Array.isArray(messages) ? messages : []).forEach((message) => {
            const messageId = Number(message?.id);
            if (!Number.isInteger(messageId) || seen.has(messageId)) {
                return;
            }
            seen.add(messageId);
            unique.push(message);
        });

        chat.pinned_messages = unique;
        chat.pinned_message = unique[0] || null;

        if (!unique.length) {
            delete chat._activePinnedIndex;
            return unique;
        }

        let nextIndex = 0;
        if (preferredMessageId) {
            const preferredId = Number(preferredMessageId);
            const preferredIndex = unique.findIndex((message) => Number(message.id) === preferredId);
            if (preferredIndex >= 0) {
                nextIndex = preferredIndex;
            }
        } else {
            const rawIndex = Number(chat._activePinnedIndex);
            if (Number.isInteger(rawIndex)) {
                nextIndex = Math.min(Math.max(rawIndex, 0), unique.length - 1);
            }
        }

        chat._activePinnedIndex = nextIndex;
        return unique;
    }

    function cyclePinnedBannerMessage() {
        const chat = getCurrentChat();
        const pinnedMessages = getPinnedMessages(chat);
        if (!chat || pinnedMessages.length < 2) {
            return;
        }

        const rawIndex = Number(chat._activePinnedIndex);
        const currentIndex = Number.isInteger(rawIndex) ? Math.min(Math.max(rawIndex, 0), pinnedMessages.length - 1) : 0;
        chat._activePinnedIndex = (currentIndex + 1) % pinnedMessages.length;
        helpers.setChatHeader(chat);
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
        updateScrollToLatestButton(true);
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
        updateScrollToLatestButton();
    }

    function updateScrollToLatestButton(forceHide = false) {
        if (!refs.scrollToLatestBtn) {
            return;
        }

        if (forceHide || !state.currentChatId) {
            refs.scrollToLatestBtn.classList.add("hidden");
            return;
        }

        const hasOverflow = refs.messagesScroll.scrollHeight - refs.messagesScroll.clientHeight > 56;
        const shouldShow = hasOverflow && !isNearBottom(72);
        refs.scrollToLatestBtn.classList.toggle("hidden", !shouldShow);
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
            const first = message.reply_to.attachments[0];
            if (first.kind === "image") {
                return "Фото";
            }
            const mime = String(first.mime_type || "").toLowerCase();
            const fileName = String(first.file_name || "").toLowerCase();
            if (mime.startsWith("audio/") || (fileName.startsWith("voice-") && fileName.endsWith(".webm"))) {
                return "Аудио";
            }
            return "Файл";
        }

        const cached = findMessageById(message.chat_id, message.reply_to_id);
        if (!cached) {
            return "Сообщение";
        }

        if (cached.content) {
            return cached.content;
        }

        if (cached.attachments?.length) {
            const first = cached.attachments[0];
            if (first.kind === "image") {
                return "Фото";
            }
            const mime = String(first.mime_type || "").toLowerCase();
            const fileName = String(first.file_name || "").toLowerCase();
            if (mime.startsWith("audio/") || (fileName.startsWith("voice-") && fileName.endsWith(".webm"))) {
                return "Аудио";
            }
            return "Файл";
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
        const messageId = Number(message.id);
        return getPinnedMessages().some((pinned) => Number(pinned.id) === messageId);
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
        const rawFileName = String(attachment.file_name || "\u0424\u0430\u0439\u043b");
        const fileName = helpers.escapeHtml(rawFileName);
        const rawFileUrl = String(attachment.file_url || "#");
        const rawPreviewUrl = String(attachment.preview_url || rawFileUrl);
        const fileUrl = helpers.escapeHtml(rawFileUrl);
        const previewUrl = helpers.escapeHtml(rawPreviewUrl);
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
                        <img class="message__file-image" src="${previewUrl}" alt="${fileName}" loading="lazy" />
                    </a>
                </div>
            `;
        }

        if (mediaKind === "video") {
            return `
                <div class="message__file message__file--video">
                    <a
                        class="message__file-preview message__file-preview--video"
                        href="${fileUrl}"
                        data-previewable="1"
                        data-kind="video"
                        data-url="${fileUrl}"
                        data-name="${fileName}"
                        data-mime="${mime}"
                    >
                        <video class="message__file-video" preload="metadata" playsinline muted>
                            <source src="${fileUrl}" type="${mime}" />
                        </video>
                        <span class="message__file-video-play">
                            <i class="fa-solid fa-play"></i>
                        </span>
                        <span class="message__file-video-name">${fileName}</span>
                    </a>
                </div>
            `;
        }

        if (mediaKind === "audio") {
            const isVoiceClipName = /^voice-\d{6}\.(webm|ogg|m4a|wav|mp3|aac|opus)$/i.test(rawFileName);
            const audioCaption = isVoiceClipName
                ? "\u0413\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435"
                : fileName;
            return `
                <div class="message__file message__file--audio">
                    <div class="message__audio-player" data-audio-player>
                        <audio class="message__audio-source" preload="metadata">
                            <source src="${fileUrl}" type="${mime}" />
                        </audio>
                        <button class="message__audio-toggle" type="button" data-audio-toggle aria-label="Воспроизвести">
                            <i class="fa-solid fa-play"></i>
                        </button>
                        <div class="message__audio-main">
                            <input
                                class="message__audio-seek"
                                type="range"
                                min="0"
                                max="1000"
                                step="1"
                                value="0"
                                data-audio-seek
                                aria-label="Перемотка аудио"
                            />
                            <div class="message__audio-time">
                                <span data-audio-current>0:00</span>
                                <span data-audio-duration>0:00</span>
                            </div>
                        </div>
                    </div>
                    <a class="message__audio-download" href="${fileUrl}" target="_blank" rel="noopener noreferrer">
                        <i class="fa-solid fa-music"></i>
                        <span>${audioCaption}</span>
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

        if (mime.startsWith("audio/")) {
            return "audio";
        }

        if (mime.startsWith("video/")) {
            return "video";
        }

        if (extension === "webm") {
            return fileName.startsWith("voice-") ? "audio" : "video";
        }

        if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(extension)) {
            return "audio";
        }

        if (["mp4", "mov", "mkv", "avi", "m4v"].includes(extension)) {
            return "video";
        }

        return "file";
    }

    function formatAudioTime(seconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainderSeconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainderSeconds).padStart(2, "0")}`;
        }

        return `${minutes}:${String(remainderSeconds).padStart(2, "0")}`;
    }

    function setAudioToggleState(button, isPlaying) {
        if (!button) {
            return;
        }

        const icon = button.querySelector("i");
        button.dataset.state = isPlaying ? "playing" : "paused";
        button.setAttribute("aria-label", isPlaying ? "Пауза" : "Воспроизвести");

        if (icon) {
            icon.className = isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
        }
    }

    function bindAudioPlayers(scope = refs.messagesList) {
        const players = scope.querySelectorAll("[data-audio-player]");
        if (!players.length) {
            return;
        }

        players.forEach((player) => {
            if (player.dataset.bound === "1") {
                return;
            }

            const audio = player.querySelector("audio");
            const toggleButton = player.querySelector("[data-audio-toggle]");
            const seekInput = player.querySelector("[data-audio-seek]");
            const currentLabel = player.querySelector("[data-audio-current]");
            const durationLabel = player.querySelector("[data-audio-duration]");

            if (!audio || !toggleButton || !seekInput || !currentLabel || !durationLabel) {
                return;
            }

            let isSeeking = false;

            const syncUi = () => {
                const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
                const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;

                if (!isSeeking) {
                    const progress = duration > 0 ? Math.round((currentTime / duration) * 1000) : 0;
                    seekInput.value = String(Math.max(0, Math.min(1000, progress)));
                }

                currentLabel.textContent = formatAudioTime(currentTime);
                durationLabel.textContent = formatAudioTime(duration);
                setAudioToggleState(toggleButton, !audio.paused && !audio.ended);
            };

            const applySeek = () => {
                const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
                if (duration <= 0) {
                    return;
                }
                const ratio = Number(seekInput.value) / 1000;
                audio.currentTime = duration * Math.max(0, Math.min(1, ratio));
            };

            toggleButton.addEventListener("click", () => {
                if (audio.paused || audio.ended) {
                    const allAudio = refs.messagesList.querySelectorAll("[data-audio-player] audio");
                    allAudio.forEach((node) => {
                        if (node !== audio) {
                            node.pause();
                        }
                    });
                    void audio.play().catch(() => {});
                } else {
                    audio.pause();
                }
            });

            seekInput.addEventListener("pointerdown", () => {
                isSeeking = true;
            });
            seekInput.addEventListener("pointerup", () => {
                applySeek();
                isSeeking = false;
                syncUi();
            });
            seekInput.addEventListener("input", () => {
                applySeek();
                syncUi();
            });
            seekInput.addEventListener("change", () => {
                applySeek();
                isSeeking = false;
                syncUi();
            });

            audio.addEventListener("play", () => {
                const allAudio = refs.messagesList.querySelectorAll("[data-audio-player] audio");
                allAudio.forEach((node) => {
                    if (node !== audio) {
                        node.pause();
                    }
                });
                syncUi();
            });
            audio.addEventListener("pause", syncUi);
            audio.addEventListener("ended", () => {
                isSeeking = false;
                syncUi();
            });
            audio.addEventListener("timeupdate", syncUi);
            audio.addEventListener("loadedmetadata", syncUi);
            audio.addEventListener("durationchange", syncUi);

            player.dataset.bound = "1";
            syncUi();
        });
    }

    function splitAttachmentBlocks(attachments = []) {
        const blocks = [];
        let imageBuffer = [];

        const flushImageBuffer = () => {
            while (imageBuffer.length > 0) {
                const group = imageBuffer.slice(0, MAX_IMAGE_ATTACHMENT_GROUP_SIZE);
                if (group.length === 1) {
                    blocks.push({
                        type: "single",
                        attachment: group[0],
                    });
                } else {
                    blocks.push({
                        type: "image-group",
                        attachments: group,
                    });
                }
                imageBuffer = imageBuffer.slice(MAX_IMAGE_ATTACHMENT_GROUP_SIZE);
            }
        };

        attachments.forEach((attachment) => {
            const mediaKind = detectAttachmentKind(attachment);
            if (mediaKind === "image") {
                imageBuffer.push(attachment);
                return;
            }

            flushImageBuffer();
            blocks.push({
                type: "single",
                attachment,
            });
        });

        flushImageBuffer();
        return blocks;
    }

    function openAttachmentPreview({
        kind,
        url,
        name,
        mimeType = "",
        galleryItems = null,
        galleryIndex = 0,
    }) {
        if (!url || !kind || kind === "file") {
            return;
        }

        const isZoomable = kind === "image";
        const normalizedGallery = isZoomable && Array.isArray(galleryItems) && galleryItems.length
            ? galleryItems
                .filter((item) => item && item.url)
                .map((item) => ({
                    url: String(item.url),
                    name: String(item.name || "Файл"),
                    mimeType: String(item.mimeType || ""),
                }))
            : [{
                url: String(url),
                name: String(name || "Файл"),
                mimeType: String(mimeType || ""),
            }];
        const hasGalleryNavigation = isZoomable && normalizedGallery.length > 1;
        let currentGalleryIndex = hasGalleryNavigation
            ? Math.min(Math.max(Number(galleryIndex) || 0, 0), normalizedGallery.length - 1)
            : 0;

        const currentItem = () => normalizedGallery[currentGalleryIndex] || normalizedGallery[0];
        const safeName = helpers.escapeHtml(currentItem().name || "Файл");
        const safeUrl = helpers.escapeHtml(currentItem().url);
        const safeMime = helpers.escapeHtml(currentItem().mimeType || mimeType || "");

        let content = "";
        if (kind === "image") {
            content = `<img id="media-preview-image" class="media-preview__image media-preview__zoom-target" src="${safeUrl}" alt="${safeName}" />`;
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
                ${hasGalleryNavigation ? `
                    <button id="media-preview-prev" class="icon-btn media-preview__nav media-preview__nav--prev" type="button" aria-label="Предыдущее фото">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <button id="media-preview-next" class="icon-btn media-preview__nav media-preview__nav--next" type="button" aria-label="Следующее фото">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                    <div id="media-preview-counter" class="media-preview__counter">${currentGalleryIndex + 1} / ${normalizedGallery.length}</div>
                ` : ""}
                <div class="media-preview__body${isZoomable ? " media-preview__body--zoomable" : ""}">
                    ${content}
                </div>
            </div>
        `, () => {
            const closeButton = document.getElementById("media-preview-close");
            const prevButton = document.getElementById("media-preview-prev");
            const nextButton = document.getElementById("media-preview-next");
            const counter = document.getElementById("media-preview-counter");
            refs.modal.classList.add("modal--media-preview");
            refs.modalOverlay?.classList.add("modal-overlay--media-preview");

            if (!isZoomable) {
                closeButton?.addEventListener("click", helpers.hideModal);
                return;
            }

            const zoomTarget = document.getElementById("media-preview-image");
            const zoomBody = document.querySelector(".media-preview__body");

            if (!zoomTarget || !zoomBody) {
                closeButton?.addEventListener("click", helpers.hideModal);
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
            let swipeStartX = null;
            let swipeStartY = null;

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

            const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

            const getLocalFocusPoint = (focusClientX, focusClientY) => {
                const rect = zoomBody.getBoundingClientRect();
                const hasFocus = Number.isFinite(focusClientX) && Number.isFinite(focusClientY);
                const localX = hasFocus ? focusClientX - rect.left : rect.width / 2;
                const localY = hasFocus ? focusClientY - rect.top : rect.height / 2;
                return {
                    x: clamp(localX, 0, rect.width),
                    y: clamp(localY, 0, rect.height),
                };
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

            const resetZoom = () => {
                scale = 1;
                baseWidth = 0;
                applyZoom();
            };

            const changeScale = (nextScale, focusClientX = null, focusClientY = null) => {
                const previousScale = scale;
                const targetScale = Math.min(maxScale, Math.max(minScale, nextScale));

                if (Math.abs(targetScale - previousScale) < 0.0001) {
                    return;
                }

                const focusPoint = getLocalFocusPoint(focusClientX, focusClientY);
                const contentFocusX = zoomBody.scrollLeft + focusPoint.x;
                const contentFocusY = zoomBody.scrollTop + focusPoint.y;

                scale = targetScale;
                applyZoom();

                const scaleRatio = scale / previousScale;
                window.requestAnimationFrame(() => {
                    zoomBody.scrollLeft = contentFocusX * scaleRatio - focusPoint.x;
                    zoomBody.scrollTop = contentFocusY * scaleRatio - focusPoint.y;
                });
            };

            const setGalleryIndex = (nextIndex) => {
                if (!hasGalleryNavigation || !normalizedGallery.length) {
                    return;
                }

                const total = normalizedGallery.length;
                currentGalleryIndex = ((Number(nextIndex) % total) + total) % total;
                const nextItem = currentItem();
                zoomTarget.src = nextItem.url;
                zoomTarget.alt = nextItem.name || "Файл";

                if (counter) {
                    counter.textContent = `${currentGalleryIndex + 1} / ${normalizedGallery.length}`;
                }

                resetZoom();
            };

            const showNext = () => setGalleryIndex(currentGalleryIndex + 1);
            const showPrev = () => setGalleryIndex(currentGalleryIndex - 1);

            let keydownHandler = null;
            const closePreview = () => {
                if (keydownHandler) {
                    document.removeEventListener("keydown", keydownHandler);
                    keydownHandler = null;
                }
                helpers.hideModal();
            };

            closeButton?.addEventListener("click", closePreview);

            if (hasGalleryNavigation) {
                prevButton?.addEventListener("click", (event) => {
                    event.preventDefault();
                    showPrev();
                });
                nextButton?.addEventListener("click", (event) => {
                    event.preventDefault();
                    showNext();
                });

                keydownHandler = (event) => {
                    if (refs.modalOverlay.classList.contains("hidden") || !refs.modal.classList.contains("modal--media-preview")) {
                        document.removeEventListener("keydown", keydownHandler);
                        keydownHandler = null;
                        return;
                    }
                    if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        showPrev();
                    } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        showNext();
                    }
                };
                document.addEventListener("keydown", keydownHandler);
            }

            zoomBody.addEventListener("wheel", (event) => {
                event.preventDefault();
                const direction = event.deltaY > 0 ? -zoomStep : zoomStep;
                changeScale(scale + direction, event.clientX, event.clientY);
            }, { passive: false });

            zoomTarget.addEventListener("dblclick", (event) => {
                if (scale <= 1.001) {
                    changeScale(2, event.clientX, event.clientY);
                } else {
                    changeScale(1, event.clientX, event.clientY);
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
                    if (hasGalleryNavigation && event.touches.length === 1 && scale <= minScale + 0.001) {
                        swipeStartX = event.touches[0].clientX;
                        swipeStartY = event.touches[0].clientY;
                    }
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
                    const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
                    const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
                    changeScale(pinchStartScale * factor, centerX, centerY);
                    event.preventDefault();
                }, { passive: false });

                zoomBody.addEventListener("touchend", (event) => {
                    if (hasGalleryNavigation && swipeStartX !== null && swipeStartY !== null && event.changedTouches.length === 1 && scale <= minScale + 0.001) {
                        const touch = event.changedTouches[0];
                        const deltaX = touch.clientX - swipeStartX;
                        const deltaY = touch.clientY - swipeStartY;
                        if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
                            if (deltaX < 0) {
                                showNext();
                            } else {
                                showPrev();
                            }
                        }
                    }
                    swipeStartX = null;
                    swipeStartY = null;
                    if (event.touches.length >= 2) {
                        return;
                    }
                    pinchStartDistance = 0;
                });

                zoomBody.addEventListener("touchcancel", () => {
                    swipeStartX = null;
                    swipeStartY = null;
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

            zoomTarget.addEventListener("load", () => {
                baseWidth = 0;
                setBaseWidth();
                applyZoom();
            });

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
        const isCallMessage = message.message_type === "call";

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
        bubble.className = `message ${isMine ? "message--mine" : "message--other"} ${isDeleted ? "message--deleted" : ""} ${isCallMessage ? "message--call" : ""}`;
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
        content.className = `message__content ${isCallMessage ? "message__content--call" : ""}`;

        if (isDeleted) {
            content.textContent = "Сообщение удалено";
        } else if (isCallMessage) {
            const icon = document.createElement("span");
            icon.className = "message__call-icon";
            icon.innerHTML = "<i class=\"fa-solid fa-phone\"></i>";

            const text = document.createElement("span");
            text.textContent = message.content || "Звонок";

            content.append(icon, text);
        } else {
            content.textContent = message.content || "";
        }
        bubble.appendChild(content);

        if (!isDeleted && message.attachments?.length) {
            const files = document.createElement("div");
            files.className = "message__files";

            const blocks = splitAttachmentBlocks(message.attachments);
            blocks.forEach((block) => {
                if (block.type === "image-group") {
                    if (block.attachments.length > 1) {
                        bubble.classList.add("message--has-gallery");
                    }
                    const gallery = document.createElement("div");
                    gallery.className = "message__gallery";
                    gallery.dataset.previewGallery = "1";
                    gallery.dataset.count = String(block.attachments.length || 0);
                    gallery.innerHTML = block.attachments.map(renderAttachment).join("");
                    files.appendChild(gallery);
                    return;
                }

                if (block.attachment) {
                    files.insertAdjacentHTML("beforeend", renderAttachment(block.attachment));
                }
            });
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
        bindAudioPlayers(refs.messagesList);
        renderTypingIndicator();
        updateScrollToLatestButton();
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
        const isCallMessage = message.message_type === "call";

        refs.contextMenu.querySelectorAll("button[data-action]").forEach((button) => {
            const action = button.dataset.action;

            if (action === "edit" || action === "delete") {
                if (action === "edit" && isCallMessage) {
                    button.style.display = "none";
                    return;
                }
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

    async function scrollToChatStart() {
        const chatId = state.currentChatId;
        if (!chatId) {
            return;
        }

        const lazyState = ensureLazyState(chatId);
        let attempts = 0;
        let previousOldestId = null;

        while (lazyState.hasMore && attempts < 80) {
            const messages = getChatMessages(chatId);
            if (!messages.length) {
                break;
            }

            const oldestMessage = messages[0];
            const oldestId = Number(oldestMessage?.id);
            if (!oldestId || oldestId === previousOldestId) {
                break;
            }

            previousOldestId = oldestId;
            await loadMessages(chatId, {
                before: oldestId,
                appendToTop: true,
            });
            attempts += 1;
        }

        refs.messagesScroll.scrollTo({
            top: 0,
            behavior: "smooth",
        });
        updateAutoScrollState();
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

    function summarizeSearchMessage(message) {
        const content = (message?.content || "").trim();
        if (content) {
            return content;
        }

        const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
        if (!attachments.length) {
            return "Пустое сообщение";
        }

        const imageCount = attachments.filter((item) => item?.kind === "image").length;
        if (imageCount > 0 && imageCount === attachments.length) {
            return imageCount > 1 ? `Фото (${imageCount})` : "Фото";
        }

        const audioCount = attachments.filter((item) => String(item?.mime_type || "").toLowerCase().startsWith("audio/")).length;
        if (audioCount > 0 && audioCount === attachments.length) {
            return audioCount > 1 ? `Аудио (${audioCount})` : "Аудио";
        }

        const first = attachments[0];
        if (first?.file_name) {
            return first.file_name;
        }
        return "Вложение";
    }

    function truncateText(text, maxLength = 140) {
        const value = String(text || "");
        if (value.length <= maxLength) {
            return value;
        }
        return `${value.slice(0, maxLength - 1)}…`;
    }

    function openSearchModal() {
        try {
            const chatId = Number(state.currentChatId);
            if (!chatId) {
                helpers.showToast("Сначала выберите чат");
                return;
            }

            const currentChat = getCurrentChat();
            const chatTitle = helpers.escapeHtml(currentChat?.title || "Текущий чат");

            helpers.showModal(`
            <h3>Поиск сообщений</h3>
            <div class="message-search-modal">
                <div class="message-search-modal__chat">${chatTitle}</div>
                <div class="input-wrap message-search-modal__input-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="message-search-input" type="search" placeholder="Текст сообщения или имя файла" autocomplete="off" />
                </div>
                <div id="message-search-status" class="message-search-modal__status">Введите текст для поиска</div>
                <div id="message-search-results" class="message-search-modal__results custom-scroll"></div>
                <div class="modal-actions">
                    <button id="message-search-close-btn" class="btn btn-soft" type="button">Закрыть</button>
                </div>
            </div>
        `, () => {
            const input = document.getElementById("message-search-input");
            const status = document.getElementById("message-search-status");
            const resultsContainer = document.getElementById("message-search-results");
            const closeButton = document.getElementById("message-search-close-btn");

            if (!input || !status || !resultsContainer || !closeButton) {
                return;
            }

            closeButton.addEventListener("click", helpers.hideModal);

            let debounceId = null;
            let requestSeq = 0;
            let latestRenderedSeq = 0;
            let currentResults = [];

            const focusMessage = async (messageId) => {
                if (!messageId) {
                    return;
                }
                helpers.hideModal();
                const found = await jumpToMessage(messageId);
                if (!found) {
                    helpers.showToast("Сообщение не найдено");
                }
            };

            const renderResults = (messages) => {
                currentResults = Array.isArray(messages) ? messages : [];
                resultsContainer.innerHTML = "";

                if (!currentResults.length) {
                    status.textContent = "Совпадений не найдено";
                    return;
                }

                status.textContent = `Найдено: ${currentResults.length}`;
                currentResults.forEach((message) => {
                    const item = document.createElement("button");
                    item.type = "button";
                    item.className = "message-search-modal__item";
                    item.dataset.messageId = String(message.id);

                    const senderName = message.sender_id === state.me?.id
                        ? "Вы"
                        : (message.sender?.display_name || message.sender?.username || "Пользователь");
                    const snippet = truncateText(summarizeSearchMessage(message), 160);
                    const timeLabel = helpers.formatChatTime(message.created_at);

                    item.innerHTML = `
                        <div class="message-search-modal__item-meta">
                            <span class="message-search-modal__item-author">${helpers.escapeHtml(senderName)}</span>
                            <span class="message-search-modal__item-time">${helpers.escapeHtml(timeLabel)}</span>
                        </div>
                        <div class="message-search-modal__item-text">${helpers.escapeHtml(snippet)}</div>
                    `;

                    item.addEventListener("click", () => {
                        void focusMessage(Number(item.dataset.messageId));
                    });

                    resultsContainer.appendChild(item);
                });
            };

            const performSearch = async () => {
                const query = input.value.trim();
                if (!query) {
                    requestSeq += 1;
                    latestRenderedSeq = requestSeq;
                    currentResults = [];
                    resultsContainer.innerHTML = "";
                    status.textContent = "Введите текст для поиска";
                    return;
                }

                const seq = ++requestSeq;
                status.textContent = "Поиск...";
                resultsContainer.innerHTML = "";

                try {
                    const response = await api.searchChatMessages(chatId, query, 80);
                    if (seq < latestRenderedSeq) {
                        return;
                    }
                    latestRenderedSeq = seq;
                    renderResults(response.messages || []);
                } catch (error) {
                    if (seq < latestRenderedSeq) {
                        return;
                    }
                    latestRenderedSeq = seq;
                    currentResults = [];
                    resultsContainer.innerHTML = "";
                    status.textContent = "Ошибка поиска";
                    helpers.showToast(error.message || "Не удалось выполнить поиск");
                }
            };

            input.addEventListener("input", () => {
                window.clearTimeout(debounceId);
                debounceId = window.setTimeout(() => {
                    void performSearch();
                }, 220);
            });

            input.addEventListener("keydown", (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    helpers.hideModal();
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    if (currentResults.length) {
                        void focusMessage(Number(currentResults[0].id));
                    } else {
                        void performSearch();
                    }
                }
            });

            input.focus();
        });
        } catch (error) {
            console.error("openSearchModal error", error);
            helpers.showToast("Не удалось открыть поиск сообщений");
        }
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
        updateScrollToLatestButton(true);

        if (cachedMessages.length) {
            renderMessages(chatId);
            scrollToBottom(false);
        }

        clearComposerState();
        refs.messageInput.value = "";
        autoResizeInput();

        ensureLazyState(chatId);

        await loadMessages(chatId, { before: null, appendToTop: false });
        updateAutoScrollState();

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
            } else {
                updateAutoScrollState();
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
            updateAutoScrollState();
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

        const chat = deps.chats.getChatById(chatId);
        if (chat) {
            const currentPinned = getPinnedMessages(chat);
            const nextPinned = currentPinned.filter((item) => Number(item.id) !== Number(messageId));
            if (nextPinned.length !== currentPinned.length) {
                applyPinnedMessages(chat, nextPinned);
                deps.chats.upsertChat(chat);
                if (state.currentChatId === chatId) {
                    helpers.setChatHeader(chat);
                }
            }
        }

        if (state.currentChatId === chatId) {
            renderMessages(chatId);
            updateAutoScrollState();
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

        const nextPinned = [payload.message, ...getPinnedMessages(chat).filter((item) => Number(item.id) !== Number(payload.message.id))];
        applyPinnedMessages(chat, nextPinned, payload.message.id);
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

        const messageId = Number(payload.message_id);
        const nextPinned = getPinnedMessages(chat).filter((item) => Number(item.id) !== messageId);
        const previousCurrentId = Number(refs.pinnedWrapper.dataset.messageId);
        applyPinnedMessages(chat, nextPinned, previousCurrentId === messageId ? null : previousCurrentId);

        deps.chats.upsertChat(chat);
        if (state.currentChatId === chatId) {
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
            updateAutoScrollState();
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

        refs.scrollToLatestBtn?.addEventListener("click", () => {
            scrollToBottom(true);
            syncCurrentChatRead();
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

            const kind = previewTarget.dataset.kind;
            const openPayload = {
                kind,
                url: previewTarget.dataset.url,
                name: previewTarget.dataset.name,
                mimeType: previewTarget.dataset.mime,
            };

            if (kind === "image") {
                const galleryRoot = previewTarget.closest("[data-preview-gallery='1']");
                if (galleryRoot) {
                    const galleryNodes = Array.from(galleryRoot.querySelectorAll("[data-previewable='1'][data-kind='image']"));
                    const galleryItems = galleryNodes.map((node) => ({
                        url: node.dataset.url,
                        name: node.dataset.name,
                        mimeType: node.dataset.mime,
                    })).filter((item) => item.url);
                    const galleryIndex = galleryNodes.indexOf(previewTarget);

                    if (galleryItems.length > 0) {
                        openPayload.galleryItems = galleryItems;
                        openPayload.galleryIndex = galleryIndex >= 0 ? galleryIndex : 0;
                    }
                }
            }

            openAttachmentPreview(openPayload);
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
                return;
            }

            if (!refs.pinnedWrapper.dataset.messageId) {
                return;
            }

            event.preventDefault();
            cyclePinnedBannerMessage();
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
        updateScrollToLatestButton(true);
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
        openSearchModal,
        renderTypingIndicator,
        scrollToChatStart,
    };
}
