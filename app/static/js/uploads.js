export function initUploadsModule(app) {
    const { refs, state, helpers, config } = app;

    const deps = {
        messages: null,
    };

    let dragCounter = 0;

    function setDropZoneVisible(visible) {
        refs.dropZone.classList.toggle("hidden", !visible);
    }

    function toFileArray(input) {
        if (!input) {
            return [];
        }

        return Array.from(input).filter((file) => file instanceof File);
    }

    function normalizeFiles(nextFiles) {
        const maxFiles = config.maxUploadFiles || 10;
        const current = state.selectedFiles || [];
        const map = new Map();

        current.forEach((file) => {
            map.set(`${file.name}:${file.size}:${file.lastModified}`, file);
        });

        nextFiles.forEach((file) => {
            map.set(`${file.name}:${file.size}:${file.lastModified}`, file);
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

    function renderPreview() {
        refs.uploadPreview.innerHTML = "";

        if (!state.selectedFiles.length) {
            refs.uploadPreview.classList.add("hidden");
            return;
        }

        refs.uploadPreview.classList.remove("hidden");

        state.selectedFiles.forEach((file, index) => {
            const chip = document.createElement("div");
            chip.className = "upload-chip";

            const isImage = file.type.startsWith("image/");
            const iconClass = isImage ? "fa-regular fa-image" : "fa-regular fa-file";

            chip.innerHTML = `
                <i class="${iconClass}"></i>
                <div class="upload-chip__meta">
                    <div class="upload-chip__name">${helpers.escapeHtml(file.name)}</div>
                    <div class="upload-chip__size">${formatFileSize(file.size)}</div>
                </div>
                <button class="upload-chip__remove" type="button" aria-label="Удалить файл">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;

            chip.querySelector(".upload-chip__remove").addEventListener("click", () => {
                state.selectedFiles.splice(index, 1);
                renderPreview();
            });

            refs.uploadPreview.appendChild(chip);
        });
    }

    function addFiles(filesInput) {
        const incoming = toFileArray(filesInput);
        if (!incoming.length) {
            return;
        }

        state.selectedFiles = normalizeFiles(incoming);
        renderPreview();
    }

    function clearFiles() {
        state.selectedFiles = [];
        refs.fileInput.value = "";
        renderPreview();
    }

    function getFiles() {
        return [...state.selectedFiles];
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
    };
}
