export function initUploadsModule(app) {
    const { refs, state, helpers, config } = app;

    const deps = {
        messages: null,
    };

    let dragCounter = 0;
    let uploadLocked = false;
    let previewExpanded = false;
    const uploadProgressByKey = new Map();
    const MOBILE_COLLAPSE_LIMIT = 3;

    function isCompactViewport() {
        return window.matchMedia("(max-width: 720px)").matches;
    }

    function setDropZoneVisible(visible) {
        refs.dropZone.classList.toggle("hidden", !visible);
    }

    function toFileArray(input) {
        if (!input) {
            return [];
        }

        return Array.from(input).filter((file) => file instanceof File);
    }

    function fileKey(file) {
        return `${file.name}:${file.size}:${file.lastModified}`;
    }

    function normalizeFiles(nextFiles) {
        const maxFiles = config.maxUploadFiles || 10;
        const current = state.selectedFiles || [];
        const map = new Map();

        current.forEach((file) => {
            map.set(fileKey(file), file);
        });

        nextFiles.forEach((file) => {
            map.set(fileKey(file), file);
        });

        const files = Array.from(map.values());
        if (files.length > maxFiles) {
            helpers.showToast(`Можно прикрепить максимум ${maxFiles} файлов`);
            return files.slice(0, maxFiles);
        }

        return files;
    }

    function formatFileSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return "0 B";
        }

        const units = ["B", "KB", "MB", "GB"];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    }

    function getUploadStatus(file) {
        return uploadProgressByKey.get(fileKey(file)) || null;
    }

    function setUploadStatus(file, nextStatus) {
        const key = fileKey(file);
        const previous = uploadProgressByKey.get(key) || {};

        uploadProgressByKey.set(key, {
            ...previous,
            ...nextStatus,
        });
    }

    function removeStaleUploadStatus() {
        const validKeys = new Set((state.selectedFiles || []).map((file) => fileKey(file)));

        Array.from(uploadProgressByKey.keys()).forEach((key) => {
            if (!validKeys.has(key)) {
                uploadProgressByKey.delete(key);
            }
        });
    }

    function renderPreview() {
        refs.uploadPreview.innerHTML = "";
        refs.uploadPreview.classList.remove("upload-preview--scrollable");
        refs.uploadPreview.classList.remove("upload-preview--collapsed");

        if (!state.selectedFiles.length) {
            refs.uploadPreview.classList.add("hidden");
            previewExpanded = false;
            return;
        }

        removeStaleUploadStatus();
        refs.uploadPreview.classList.remove("hidden");
        const shouldCollapse = isCompactViewport() && state.selectedFiles.length > MOBILE_COLLAPSE_LIMIT;
        const visibleFiles = shouldCollapse && !previewExpanded
            ? state.selectedFiles.slice(0, MOBILE_COLLAPSE_LIMIT)
            : state.selectedFiles;

        if (shouldCollapse && !previewExpanded) {
            refs.uploadPreview.classList.add("upload-preview--collapsed");
        }
        if (shouldCollapse && previewExpanded) {
            refs.uploadPreview.classList.add("upload-preview--scrollable");
        }

        visibleFiles.forEach((file) => {
            const status = getUploadStatus(file);
            const percent = Math.max(0, Math.min(100, Math.round(Number(status?.percent) || 0)));
            const uploadedBytes = Math.max(0, Number(status?.uploadedBytes) || 0);
            const totalBytes = Math.max(0, Number(status?.totalBytes) || file.size || 0);
            const isUploading = Boolean(status?.isUploading);
            const isDone = Boolean(status?.done);
            const hasError = Boolean(status?.error);

            const chip = document.createElement("div");
            chip.className = "upload-chip";
            if (isUploading) {
                chip.classList.add("upload-chip--uploading");
            }
            if (isDone) {
                chip.classList.add("upload-chip--done");
            }
            if (hasError) {
                chip.classList.add("upload-chip--error");
            }

            const isImage = file.type.startsWith("image/");
            const iconClass = isImage ? "fa-regular fa-image" : "fa-regular fa-file";
            const showProgress = isUploading || isDone || hasError || percent > 0;

            let statusText = "";
            if (hasError) {
                statusText = helpers.escapeHtml(String(status.error));
            } else if (isDone) {
                statusText = "Загружено";
            } else if (isUploading) {
                statusText = `${percent}% • ${formatFileSize(uploadedBytes)} / ${formatFileSize(totalBytes)}`;
            }

            chip.innerHTML = `
                <i class="${iconClass}"></i>
                <div class="upload-chip__meta">
                    <div class="upload-chip__name">${helpers.escapeHtml(file.name)}</div>
                    <div class="upload-chip__size">${formatFileSize(file.size)}</div>
                    ${showProgress ? `
                        <div class="upload-chip__progress-wrap">
                            <div class="upload-chip__progress-text">${statusText}</div>
                            <div class="upload-chip__progress-track">
                                <div class="upload-chip__progress-bar" style="width: ${percent}%"></div>
                            </div>
                        </div>
                    ` : ""}
                </div>
                <button class="upload-chip__remove" type="button" aria-label="Удалить файл" ${uploadLocked || isUploading ? "disabled" : ""}>
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;

            chip.querySelector(".upload-chip__remove").addEventListener("click", () => {
                if (uploadLocked || isUploading) {
                    return;
                }

                const index = state.selectedFiles.findIndex((item) => fileKey(item) === fileKey(file));
                if (index < 0) {
                    return;
                }
                state.selectedFiles.splice(index, 1);
                if (state.selectedFiles.length <= MOBILE_COLLAPSE_LIMIT) {
                    previewExpanded = false;
                }
                renderPreview();
            });

            refs.uploadPreview.appendChild(chip);
        });

        if (shouldCollapse) {
            const hiddenCount = Math.max(0, state.selectedFiles.length - MOBILE_COLLAPSE_LIMIT);
            const toggleButton = document.createElement("button");
            toggleButton.type = "button";
            toggleButton.className = "upload-preview__toggle";
            toggleButton.textContent = previewExpanded
                ? "Свернуть список"
                : `Показать еще ${hiddenCount}`;
            toggleButton.addEventListener("click", () => {
                previewExpanded = !previewExpanded;
                renderPreview();
            });
            refs.uploadPreview.appendChild(toggleButton);
        }
    }

    function addFiles(filesInput) {
        const incoming = toFileArray(filesInput);
        if (!incoming.length) {
            return;
        }

        state.selectedFiles = normalizeFiles(incoming);
        if (isCompactViewport() && state.selectedFiles.length > MOBILE_COLLAPSE_LIMIT) {
            previewExpanded = false;
        }
        renderPreview();
    }

    function clearFiles() {
        state.selectedFiles = [];
        previewExpanded = false;
        uploadProgressByKey.clear();
        refs.fileInput.value = "";
        renderPreview();
    }

    function getFiles() {
        return [...state.selectedFiles];
    }

    function setUploadLocked(nextLocked) {
        uploadLocked = Boolean(nextLocked);
        renderPreview();
    }

    function beginUpload(files) {
        (files || []).forEach((file) => {
            setUploadStatus(file, {
                isUploading: true,
                done: false,
                error: "",
                percent: 0,
                uploadedBytes: 0,
                totalBytes: file.size || 0,
            });
        });

        renderPreview();
    }

    function updateUploadProgress({ file, uploadedBytes, totalBytes, percent }) {
        if (!file) {
            return;
        }

        setUploadStatus(file, {
            isUploading: true,
            done: false,
            error: "",
            uploadedBytes: Math.max(0, Number(uploadedBytes) || 0),
            totalBytes: Math.max(0, Number(totalBytes) || file.size || 0),
            percent: Math.max(0, Math.min(100, Number(percent) || 0)),
        });

        renderPreview();
    }

    function finishUpload(file) {
        if (!file) {
            return;
        }

        setUploadStatus(file, {
            isUploading: false,
            done: true,
            error: "",
            uploadedBytes: file.size || 0,
            totalBytes: file.size || 0,
            percent: 100,
        });

        renderPreview();
    }

    function failUpload(file, errorMessage) {
        if (!file) {
            return;
        }

        setUploadStatus(file, {
            isUploading: false,
            done: false,
            error: errorMessage || "Ошибка загрузки",
        });

        renderPreview();
    }

    function bindPaste() {
        refs.messageInput.addEventListener("paste", (event) => {
            const files = [];
            const items = event.clipboardData?.items || [];

            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                if (item.kind === "file") {
                    const file = item.getAsFile();
                    if (file) {
                        files.push(file);
                    }
                }
            }

            if (files.length) {
                addFiles(files);
                helpers.showToast(`Добавлено файлов: ${files.length}`);
            }
        });
    }

    function bindDnD() {
        const host = refs.composer;

        const preventDefaults = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
            host.addEventListener(eventName, preventDefaults);
            refs.dropZone.addEventListener(eventName, preventDefaults);
        });

        host.addEventListener("dragenter", () => {
            dragCounter += 1;
            setDropZoneVisible(true);
        });

        host.addEventListener("dragleave", () => {
            dragCounter -= 1;
            if (dragCounter <= 0) {
                dragCounter = 0;
                setDropZoneVisible(false);
            }
        });

        host.addEventListener("drop", (event) => {
            dragCounter = 0;
            setDropZoneVisible(false);
            const files = event.dataTransfer?.files;
            if (files?.length) {
                addFiles(files);
                helpers.showToast(`Добавлено файлов: ${files.length}`);
            }
        });
    }

    function bindEvents() {
        refs.attachBtn.addEventListener("click", () => {
            refs.fileInput.click();
        });

        refs.fileInput.addEventListener("change", (event) => {
            addFiles(event.target.files);
            event.target.value = "";
        });

        bindDnD();
        bindPaste();

        window.addEventListener("resize", () => {
            if (!isCompactViewport()) {
                previewExpanded = true;
            } else if (state.selectedFiles.length > MOBILE_COLLAPSE_LIMIT) {
                previewExpanded = false;
            }
            renderPreview();
        });
    }

    function attachDependencies(nextDeps) {
        deps.messages = nextDeps.messages;
    }

    return {
        attachDependencies,
        bindEvents,
        addFiles,
        clearFiles,
        getFiles,
        renderPreview,
        setUploadLocked,
        beginUpload,
        updateUploadProgress,
        finishUpload,
        failUpload,
    };
}
