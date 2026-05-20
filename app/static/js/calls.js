export function initCallsModule(app) {
    const { refs, state, helpers, config } = app;

    const deps = {
        chats: null,
        socket: null,
    };

    const callRefs = {
        overlay: document.getElementById("call-overlay"),
        panel: document.getElementById("call-panel"),
        expandFab: document.getElementById("call-expand-fab"),
        modeBadge: document.getElementById("call-mode-badge"),
        peerAvatar: document.getElementById("call-peer-avatar"),
        peerName: document.getElementById("call-peer-name"),
        statusText: document.getElementById("call-status-text"),
        remoteVideo: document.getElementById("call-remote-video"),
        localVideo: document.getElementById("call-local-video"),
        audioVisual: document.getElementById("call-audio-visual"),
        incomingActions: document.getElementById("call-incoming-actions"),
        ongoingActions: document.getElementById("call-ongoing-actions"),
        acceptBtn: document.getElementById("call-accept-btn"),
        rejectBtn: document.getElementById("call-reject-btn"),
        endBtn: document.getElementById("call-end-btn"),
        muteBtn: document.getElementById("call-mute-btn"),
        cameraBtn: document.getElementById("call-camera-btn"),
        minimizeBtn: document.getElementById("call-minimize-btn"),
    };

    const defaultStatusByPhase = {
        ringing_out: "\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u043e\u0442\u0432\u0435\u0442\u0430...",
        ringing_in: "\u0412\u0445\u043e\u0434\u044f\u0449\u0438\u0439 \u0432\u044b\u0437\u043e\u0432",
        connecting: "\u041f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435...",
        active: "\u0421\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e",
    };

    const reasonText = {
        rejected: "\u0417\u0432\u043e\u043d\u043e\u043a \u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d",
        busy: "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0437\u0430\u043d\u044f\u0442",
        offline: "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u043e\u0444\u043b\u0430\u0439\u043d",
        ended: "\u0417\u0432\u043e\u043d\u043e\u043a \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d",
        disconnected: "\u0421\u043e\u0431\u0435\u0441\u0435\u0434\u043d\u0438\u043a \u043e\u0442\u043a\u043b\u044e\u0447\u0438\u043b\u0441\u044f",
        timeout: "\u0412\u0440\u0435\u043c\u044f \u043e\u0436\u0438\u0434\u0430\u043d\u0438\u044f \u0438\u0441\u0442\u0435\u043a\u043b\u043e",
        failed: "\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u044f",
        unsupported: "\u0417\u0432\u043e\u043d\u043a\u0438 \u043d\u0435 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044e\u0442\u0441\u044f \u0432 \u044d\u0442\u043e\u043c \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435",
        insecure_context: "\u0414\u043b\u044f \u0437\u0432\u043e\u043d\u043a\u043e\u0432 \u043d\u0443\u0436\u0435\u043d HTTPS (\u0438\u043b\u0438 localhost)",
    };

    const ringtonePatterns = {
        incoming: [
            { frequency: 659.25, duration: 0.16 },
            { frequency: 830.61, duration: 0.14 },
            { frequency: 987.77, duration: 0.18 },
            { frequency: 1318.51, duration: 0.22 },
            { frequency: null, duration: 0.18 },
            { frequency: 987.77, duration: 0.16 },
            { frequency: 830.61, duration: 0.16 },
            { frequency: 659.25, duration: 0.22 },
            { frequency: null, duration: 0.54 },
            { frequency: 739.99, duration: 0.16 },
            { frequency: 880.0, duration: 0.14 },
            { frequency: 1108.73, duration: 0.18 },
            { frequency: 1479.98, duration: 0.22 },
            { frequency: null, duration: 0.2 },
            { frequency: 1108.73, duration: 0.16 },
            { frequency: 880.0, duration: 0.16 },
            { frequency: 739.99, duration: 0.24 },
            { frequency: null, duration: 0.66 },
        ],
        outgoing: [
            { frequency: 392.0, duration: 0.12 },
            { frequency: null, duration: 0.1 },
            { frequency: 523.25, duration: 0.14 },
            { frequency: null, duration: 0.54 },
        ],
    };

    let currentCall = null;
    let peerConnection = null;
    let localStream = null;
    let remoteStream = null;
    let pendingCandidates = [];
    let ringTimeoutId = null;
    let callStartedAt = null;
    let elapsedTimerId = null;
    let isMinimized = false;
    let ringtoneContext = null;
    let ringtoneMasterGain = null;
    let ringtoneLoopTimerId = null;
    let ringtoneUnlockHandlersBound = false;
    let pendingRingtoneDirection = null;
    let activeRingtoneAudio = null;
    const ringtoneAudioByDirection = {
        incoming: null,
        outgoing: null,
    };

    function getPeerConnectionCtor() {
        return window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection || null;
    }

    function hasGetUserMediaSupport() {
        if (navigator.mediaDevices?.getUserMedia) {
            return true;
        }

        return Boolean(
            navigator.getUserMedia
            || navigator.webkitGetUserMedia
            || navigator.mozGetUserMedia
            || navigator.msGetUserMedia,
        );
    }

    function isSecureContextForMedia() {
        if (window.isSecureContext) {
            return true;
        }

        const hostname = window.location?.hostname || "";
        if (!hostname) {
            return false;
        }

        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    }

    function getCallSupportErrorMessage() {
        if (!isSecureContextForMedia()) {
            return reasonText.insecure_context;
        }

        if (!getPeerConnectionCtor() || !hasGetUserMediaSupport()) {
            return reasonText.unsupported;
        }

        return "";
    }

    function supportsCalls() {
        return !getCallSupportErrorMessage();
    }

    function buildSessionId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return `call_${Date.now()}_${Math.random().toString(16).slice(2, 12)}`;
    }

    function getIceServers() {
        if (Array.isArray(config.webrtcIceServers) && config.webrtcIceServers.length > 0) {
            return config.webrtcIceServers;
        }
        return [{ urls: "stun:stun.l.google.com:19302" }];
    }

    function clearTimers() {
        if (ringTimeoutId) {
            window.clearTimeout(ringTimeoutId);
            ringTimeoutId = null;
        }

        if (elapsedTimerId) {
            window.clearInterval(elapsedTimerId);
            elapsedTimerId = null;
        }
    }

    function clampVolume(value, fallback) {
        const normalized = Number(value);
        if (!Number.isFinite(normalized)) {
            return fallback;
        }
        return Math.max(0, Math.min(1, normalized));
    }

    function getRingtoneAssetConfig(direction = "incoming") {
        if (direction === "outgoing") {
            return {
                url: String(config.webrtcRingtoneOutgoingUrl || "").trim(),
                volume: clampVolume(config.webrtcRingtoneOutgoingVolume, 0.72),
            };
        }

        return {
            url: String(config.webrtcRingtoneIncomingUrl || "").trim(),
            volume: clampVolume(config.webrtcRingtoneIncomingVolume, 0.70),
        };
    }

    function getOrCreateRingtoneAudio(direction = "incoming") {
        const key = direction === "outgoing" ? "outgoing" : "incoming";
        const { url, volume } = getRingtoneAssetConfig(key);
        if (!url) {
            return null;
        }

        const existingAudio = ringtoneAudioByDirection[key];
        if (existingAudio && existingAudio.dataset?.sourceUrl === url) {
            existingAudio.volume = volume;
            return existingAudio;
        }

        const nextAudio = new Audio(url);
        nextAudio.loop = true;
        nextAudio.preload = "auto";
        nextAudio.playsInline = true;
        nextAudio.volume = volume;
        nextAudio.dataset.sourceUrl = url;

        ringtoneAudioByDirection[key] = nextAudio;
        return nextAudio;
    }

    function ensureRingtoneContext() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            return null;
        }

        if (!ringtoneContext) {
            ringtoneContext = new AudioCtx();
        }

        if (!ringtoneMasterGain) {
            ringtoneMasterGain = ringtoneContext.createGain();
            ringtoneMasterGain.gain.value = 0.12;
            ringtoneMasterGain.connect(ringtoneContext.destination);
        }

        if (ringtoneContext.state !== "running") {
            ringtoneContext.resume().catch(() => {});
        }

        return ringtoneContext;
    }

    function unlockRingtoneAudio() {
        let unlocked = false;
        const context = ensureRingtoneContext();
        if (context) {
            if (context.state !== "running") {
                context.resume().catch(() => {});
            }

            try {
                const oscillator = context.createOscillator();
                const gainNode = context.createGain();
                gainNode.gain.value = 0.00001;
                oscillator.connect(gainNode);
                gainNode.connect(context.destination);
                oscillator.start();
                oscillator.stop(context.currentTime + 0.01);
                unlocked = true;
            } catch (_error) {
                // Ignore unlock probe errors.
            }
        }

        ["incoming", "outgoing"].forEach((direction) => {
            const audio = getOrCreateRingtoneAudio(direction);
            if (!audio) {
                return;
            }

            const prevMuted = audio.muted;
            audio.muted = true;

            try {
                const playResult = audio.play();
                if (playResult && typeof playResult.then === "function") {
                    playResult
                        .then(() => {
                            audio.pause();
                            audio.currentTime = 0;
                            audio.muted = prevMuted;
                        })
                        .catch(() => {
                            audio.muted = prevMuted;
                        });
                } else {
                    audio.pause();
                    audio.currentTime = 0;
                    audio.muted = prevMuted;
                }
                unlocked = true;
            } catch (_error) {
                audio.muted = prevMuted;
            }
        });

        if (currentCall?.phase === "ringing" && pendingRingtoneDirection) {
            const nextDirection = pendingRingtoneDirection;
            pendingRingtoneDirection = null;
            startRingtone(nextDirection);
        }

        return unlocked;
    }

    function playAudioRingtone(direction = "incoming") {
        const audio = getOrCreateRingtoneAudio(direction);
        if (!audio) {
            return false;
        }

        try {
            audio.currentTime = 0;
            audio.muted = false;
            activeRingtoneAudio = audio;

            const playResult = audio.play();
            if (playResult && typeof playResult.then === "function") {
                playResult.catch(() => {
                    if (activeRingtoneAudio === audio) {
                        activeRingtoneAudio = null;
                    }
                    pendingRingtoneDirection = direction;
                    const pattern = ringtonePatterns[direction] || ringtonePatterns.incoming;
                    playRingtonePattern(pattern);
                });
            }

            return true;
        } catch (_error) {
            activeRingtoneAudio = null;
            return false;
        }
    }

    function bindRingtoneUnlockHandlers() {
        if (ringtoneUnlockHandlersBound) {
            return;
        }

        ringtoneUnlockHandlersBound = true;
        getOrCreateRingtoneAudio("incoming");
        getOrCreateRingtoneAudio("outgoing");

        const unlockHandler = () => {
            unlockRingtoneAudio();
        };

        const listenerOptions = { passive: true };
        window.addEventListener("pointerdown", unlockHandler, listenerOptions);
        window.addEventListener("touchstart", unlockHandler, listenerOptions);
        window.addEventListener("mousedown", unlockHandler, listenerOptions);
        window.addEventListener("keydown", unlockHandler);
        window.addEventListener("focus", unlockHandler);

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                unlockRingtoneAudio();
            }
        });
    }

    function scheduleRingtoneTone(context, startAt, note, volume = 0.24) {
        if (!note?.frequency || note.duration <= 0) {
            return;
        }

        const oscillator = context.createOscillator();
        const gainNode = context.createGain();

        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(note.frequency, startAt);

        const attackEnd = startAt + Math.min(0.02, note.duration * 0.25);
        const releaseStart = startAt + Math.max(0.03, note.duration - 0.03);
        const stopAt = startAt + note.duration;

        gainNode.gain.setValueAtTime(0.0001, startAt);
        gainNode.gain.linearRampToValueAtTime(volume, attackEnd);
        gainNode.gain.exponentialRampToValueAtTime(0.06, releaseStart);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        oscillator.connect(gainNode);
        gainNode.connect(ringtoneMasterGain);

        oscillator.start(startAt);
        oscillator.stop(stopAt + 0.02);
    }

    function playRingtonePattern(pattern) {
        const context = ensureRingtoneContext();
        if (!context || !ringtoneMasterGain || !Array.isArray(pattern) || !pattern.length) {
            return false;
        }

        const startAt = context.currentTime + 0.02;
        let cursor = startAt;

        pattern.forEach((note) => {
            scheduleRingtoneTone(context, cursor, note);
            cursor += Number(note.duration) || 0;
        });

        const loopDurationMs = Math.max(300, Math.round((cursor - startAt) * 1000));
        ringtoneLoopTimerId = window.setTimeout(() => {
            if (!currentCall || currentCall.phase !== "ringing") {
                return;
            }
            playRingtonePattern(pattern);
        }, loopDurationMs);

        return true;
    }

    function startRingtone(direction = "incoming") {
        stopRingtone();
        pendingRingtoneDirection = direction;

        const audioStarted = playAudioRingtone(direction);
        if (audioStarted) {
            pendingRingtoneDirection = null;
            return true;
        }

        const pattern = ringtonePatterns[direction] || ringtonePatterns.incoming;
        const started = playRingtonePattern(pattern);

        if (started) {
            pendingRingtoneDirection = null;
        }

        return started;
    }

    function stopRingtone() {
        if (ringtoneLoopTimerId) {
            window.clearTimeout(ringtoneLoopTimerId);
            ringtoneLoopTimerId = null;
        }

        Object.values(ringtoneAudioByDirection).forEach((audio) => {
            if (!audio) {
                return;
            }
            try {
                audio.pause();
                audio.currentTime = 0;
            } catch (_error) {
                // ignore audio pause issues
            }
        });

        activeRingtoneAudio = null;
        pendingRingtoneDirection = null;
    }

    function stopStream(stream) {
        if (!stream) {
            return;
        }
        stream.getTracks().forEach((track) => {
            track.stop();
        });
    }

    function detachMedia() {
        if (callRefs.localVideo) {
            callRefs.localVideo.srcObject = null;
        }
        if (callRefs.remoteVideo) {
            callRefs.remoteVideo.srcObject = null;
        }
    }

    function closePeerConnection() {
        if (!peerConnection) {
            return;
        }

        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }

    function resetCallState() {
        clearTimers();
        stopRingtone();
        closePeerConnection();
        stopStream(localStream);
        stopStream(remoteStream);
        localStream = null;
        remoteStream = null;
        pendingCandidates = [];
        callStartedAt = null;
        currentCall = null;
        detachMedia();
        setMinimized(false, true);
        renderCallUi();
    }

    function getCallPhaseStatus() {
        if (!currentCall) {
            return "";
        }

        if (currentCall.phase === "active" && callStartedAt) {
            const elapsedSec = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
            const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
            const ss = String(elapsedSec % 60).padStart(2, "0");
            return `${defaultStatusByPhase.active} - ${mm}:${ss}`;
        }

        if (currentCall.phase === "ringing") {
            return currentCall.direction === "incoming"
                ? defaultStatusByPhase.ringing_in
                : defaultStatusByPhase.ringing_out;
        }

        return defaultStatusByPhase[currentCall.phase] || defaultStatusByPhase.connecting;
    }

    function setStatusText(text) {
        if (!callRefs.statusText) {
            return;
        }
        callRefs.statusText.textContent = text;
    }

    function setMinimized(next, force = false) {
        if (!currentCall && !force) {
            return;
        }
        isMinimized = Boolean(next);
        callRefs.overlay?.classList.toggle("hidden", isMinimized || !currentCall);
        callRefs.expandFab?.classList.toggle("hidden", !isMinimized || !currentCall);
        document.body?.classList.toggle("call-minimized", isMinimized && Boolean(currentCall));
    }

    function updateMuteButton() {
        if (!callRefs.muteBtn) {
            return;
        }

        const icon = callRefs.muteBtn.querySelector("i");
        callRefs.muteBtn.classList.toggle("is-active", Boolean(currentCall?.isMuted));
        callRefs.muteBtn.setAttribute("aria-label", currentCall?.isMuted ? "\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u043c\u0438\u043a\u0440\u043e\u0444\u043e\u043d" : "\u0412\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u043c\u0438\u043a\u0440\u043e\u0444\u043e\u043d");

        if (icon) {
            icon.className = currentCall?.isMuted
                ? "fa-solid fa-microphone-slash"
                : "fa-solid fa-microphone";
        }
    }

    function updateCameraButton() {
        if (!callRefs.cameraBtn) {
            return;
        }

        const icon = callRefs.cameraBtn.querySelector("i");
        const isVideoCall = currentCall?.kind === "video";
        const enabled = Boolean(isVideoCall && localStream);
        callRefs.cameraBtn.disabled = !enabled;
        callRefs.cameraBtn.classList.toggle("is-active", Boolean(currentCall?.isCameraOff));
        callRefs.cameraBtn.setAttribute("aria-label", currentCall?.isCameraOff ? "\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u043a\u0430\u043c\u0435\u0440\u0443" : "\u0412\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u043a\u0430\u043c\u0435\u0440\u0443");

        if (icon) {
            icon.className = currentCall?.isCameraOff
                ? "fa-solid fa-video-slash"
                : "fa-solid fa-video";
        }
    }

    function renderCallUi() {
        const active = Boolean(currentCall);
        callRefs.overlay?.classList.toggle("hidden", !active || isMinimized);
        callRefs.expandFab?.classList.toggle("hidden", !active || !isMinimized);
        callRefs.panel?.classList.toggle("call-panel--video", Boolean(active && currentCall.kind === "video"));
        callRefs.panel?.classList.toggle("call-panel--audio", Boolean(active && currentCall.kind === "audio"));

        if (!active) {
            return;
        }

        if (callRefs.modeBadge) {
            callRefs.modeBadge.textContent = currentCall.kind === "video" ? "\u0412\u0438\u0434\u0435\u043e\u0437\u0432\u043e\u043d\u043e\u043a" : "\u0410\u0443\u0434\u0438\u043e\u0437\u0432\u043e\u043d\u043e\u043a";
        }
        if (callRefs.peerName) {
            callRefs.peerName.textContent = currentCall.peerName || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c";
        }
        if (callRefs.peerAvatar) {
            callRefs.peerAvatar.src = currentCall.peerAvatar || helpers.avatarFallback(currentCall.peerName || "User");
        }

        const status = getCallPhaseStatus();
        setStatusText(status);

        const incomingRinging = currentCall.direction === "incoming" && currentCall.phase === "ringing";
        callRefs.incomingActions?.classList.toggle("hidden", !incomingRinging);
        callRefs.ongoingActions?.classList.toggle("hidden", incomingRinging);

        if (callRefs.endBtn) {
            callRefs.endBtn.disabled = false;
        }
        if (callRefs.rejectBtn) {
            callRefs.rejectBtn.disabled = false;
        }
        if (callRefs.acceptBtn) {
            callRefs.acceptBtn.disabled = false;
        }

        if (callRefs.audioVisual) {
            const showAudioVisual = currentCall.kind === "audio";
            callRefs.audioVisual.classList.toggle("hidden", !showAudioVisual);
        }

        updateMuteButton();
        updateCameraButton();
    }

    function startElapsedTimer() {
        if (!currentCall || currentCall.phase !== "active") {
            return;
        }
        if (elapsedTimerId) {
            return;
        }
        elapsedTimerId = window.setInterval(() => {
            setStatusText(getCallPhaseStatus());
        }, 1000);
    }

    function startRingTimer() {
        if (!currentCall || currentCall.phase !== "ringing") {
            return;
        }

        const timeoutSec = Math.max(15, Number(config.webrtcRingTimeoutSec) || 90);
        ringTimeoutId = window.setTimeout(() => {
            if (!currentCall || currentCall.phase !== "ringing") {
                return;
            }
            void finishCall({
                sendEndSignal: true,
                reason: "timeout",
                toast: reasonText.timeout,
            });
        }, (timeoutSec + 5) * 1000);
    }

    function resolvePeerByChat(chatId, fallback = {}) {
        const chat = deps.chats?.getChatById(chatId);
        if (!chat) {
            return {
                userId: fallback.userId || null,
                name: fallback.name || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
                avatarUrl: fallback.avatarUrl || "",
                isGroup: false,
            };
        }

        if (chat.is_group) {
            return {
                userId: fallback.userId || null,
                name: fallback.name || chat.title || "\u0413\u0440\u0443\u043f\u043f\u0430",
                avatarUrl: fallback.avatarUrl || chat.avatar_url || "",
                isGroup: true,
            };
        }

        const peer = (chat.members || []).find((member) => member.id !== state.me?.id);
        return {
            userId: peer?.id || fallback.userId || null,
            name: peer?.display_name || chat.title || fallback.name || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
            avatarUrl: peer?.avatar_url || chat.avatar_url || fallback.avatarUrl || "",
            isGroup: false,
        };
    }

    function createPeerConnection() {
        const PeerConnectionCtor = getPeerConnectionCtor();
        const connection = new PeerConnectionCtor({
            iceServers: getIceServers(),
        });

        connection.onicecandidate = (event) => {
            if (!event.candidate || !currentCall) {
                return;
            }

            deps.socket?.callSignal({
                session_id: currentCall.sessionId,
                candidate: typeof event.candidate.toJSON === "function"
                    ? event.candidate.toJSON()
                    : event.candidate,
            });
        };

        connection.ontrack = (event) => {
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }

            const [stream] = event.streams;
            if (stream) {
                stream.getTracks().forEach((track) => {
                    if (!remoteStream.getTrackById(track.id)) {
                        remoteStream.addTrack(track);
                    }
                });
            } else if (event.track && !remoteStream.getTrackById(event.track.id)) {
                remoteStream.addTrack(event.track);
            }

            if (callRefs.remoteVideo) {
                callRefs.remoteVideo.srcObject = remoteStream;
            }

            if (currentCall && currentCall.phase !== "active") {
                currentCall.phase = "active";
                callStartedAt = Date.now();
                startElapsedTimer();
                renderCallUi();
            }
        };

        const handleConnectivity = () => {
            if (!currentCall) {
                return;
            }

            const stateName = connection.connectionState || "";

            if (stateName === "connected") {
                if (currentCall.phase !== "active") {
                    currentCall.phase = "active";
                    callStartedAt = Date.now();
                    startElapsedTimer();
                    renderCallUi();
                }
                return;
            }

            if (stateName === "failed" || stateName === "closed") {
                void finishCall({
                    sendEndSignal: stateName !== "closed",
                    reason: "failed",
                    toast: reasonText.failed,
                });
            }
        };

        connection.onconnectionstatechange = handleConnectivity;
        connection.oniceconnectionstatechange = handleConnectivity;

        return connection;
    }

    async function acquireLocalStream(kind) {
        const video = kind === "video";
        const constraints = {
            audio: true,
            video,
        };

        if (navigator.mediaDevices?.getUserMedia) {
            return navigator.mediaDevices.getUserMedia(constraints);
        }

        const legacyGetUserMedia = (
            navigator.getUserMedia
            || navigator.webkitGetUserMedia
            || navigator.mozGetUserMedia
            || navigator.msGetUserMedia
        );

        if (!legacyGetUserMedia) {
            throw new Error("getUserMedia is not available");
        }

        return new Promise((resolve, reject) => {
            legacyGetUserMedia.call(navigator, constraints, resolve, reject);
        });
    }

    function resolveMediaAccessErrorText(error) {
        if (window.isSecureContext === false) {
            return "Для звонков нужен HTTPS";
        }

        const name = String(error?.name || "").toLowerCase();
        if (name === "notallowederror" || name === "permissiondeniederror" || name === "securityerror") {
            return "Нет доступа к микрофону/камере. Разрешите доступ в настройках приложения";
        }
        if (name === "notfounderror" || name === "devicesnotfounderror") {
            return "Микрофон или камера не найдены";
        }
        if (name === "notreadableerror" || name === "trackstarterror") {
            return "Микрофон/камера заняты другим приложением";
        }

        return "Нет доступа к микрофону/камере";
    }

    async function setRemoteDescriptionSafe(connection, description) {
        if (!description) {
            throw new Error("Missing remote description");
        }

        if (window.RTCSessionDescription) {
            await connection.setRemoteDescription(new window.RTCSessionDescription(description));
            return;
        }

        await connection.setRemoteDescription(description);
    }

    async function applyPendingCandidates() {
        if (!peerConnection || !pendingCandidates.length) {
            return;
        }

        const queued = [...pendingCandidates];
        pendingCandidates = [];

        for (const candidate of queued) {
            try {
                await peerConnection.addIceCandidate(candidate);
            } catch (error) {
                console.warn("failed to apply queued ICE candidate", error);
            }
        }
    }

    async function finishCall({ sendEndSignal = false, reason = "ended", toast = "" } = {}) {
        const sessionId = currentCall?.sessionId || null;

        if (sendEndSignal && sessionId) {
            deps.socket?.callEnd({
                session_id: sessionId,
                reason,
            });
        }

        resetCallState();
        if (toast) {
            helpers.showToast(toast);
        }
    }

    async function startCall(kind = "audio") {
        const supportError = getCallSupportErrorMessage();
        if (supportError) {
            helpers.showToast(supportError);
            return;
        }

        if (!deps.socket?.isConnected()) {
            helpers.showToast("Realtime-\u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0435\u0449\u0435 \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e");
            return;
        }

        if (currentCall) {
            helpers.showToast("\u0417\u0432\u043e\u043d\u043e\u043a \u0443\u0436\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f");
            return;
        }

        if (!state.currentChatId) {
            helpers.showToast("\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0447\u0430\u0442");
            return;
        }

        const chat = deps.chats?.getChatById(state.currentChatId);
        if (!chat) {
            helpers.showToast("\u0427\u0430\u0442 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d");
            return;
        }

        if (chat.is_group) {
            helpers.showToast("\u0413\u0440\u0443\u043f\u043f\u043e\u0432\u044b\u0435 \u0437\u0432\u043e\u043d\u043a\u0438 \u043f\u043e\u043a\u0430 \u043d\u0435 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044e\u0442\u0441\u044f");
            return;
        }

        const peer = resolvePeerByChat(chat.id);
        if (!peer.userId) {
            helpers.showToast("\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0438\u0442\u044c \u0441\u043e\u0431\u0435\u0441\u0435\u0434\u043d\u0438\u043a\u0430");
            return;
        }

        try {
            localStream = await acquireLocalStream(kind);
        } catch (error) {
            console.warn("failed to access media devices", error);
            helpers.showToast(resolveMediaAccessErrorText(error));
            return;
        }

        const sessionId = buildSessionId();
        currentCall = {
            sessionId,
            chatId: chat.id,
            kind,
            direction: "outgoing",
            phase: "connecting",
            peerUserId: peer.userId,
            peerName: peer.name,
            peerAvatar: peer.avatarUrl,
            pendingOffer: null,
            isMuted: false,
            isCameraOff: false,
        };

        if (callRefs.localVideo) {
            callRefs.localVideo.srcObject = localStream;
            callRefs.localVideo.muted = true;
        }

        peerConnection = createPeerConnection();
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });

        renderCallUi();

        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            deps.socket?.callInvite({
                session_id: sessionId,
                chat_id: chat.id,
                target_user_id: peer.userId,
                kind,
                offer: peerConnection.localDescription,
            });

            currentCall.phase = "ringing";
            renderCallUi();
            startRingtone("outgoing");
            startRingTimer();
        } catch (error) {
            console.warn("failed to start call", error);
            await finishCall({
                reason: "failed",
                toast: reasonText.failed,
            });
        }
    }

    async function acceptIncomingCall() {
        if (!currentCall || currentCall.direction !== "incoming" || currentCall.phase !== "ringing") {
            return;
        }

        const { pendingOffer, kind, sessionId } = currentCall;
        if (!pendingOffer) {
            await finishCall({
                reason: "failed",
                toast: reasonText.failed,
            });
            return;
        }

        clearTimers();
        stopRingtone();

        try {
            localStream = await acquireLocalStream(kind);
        } catch (error) {
            deps.socket?.callReject({
                session_id: sessionId,
                reason: "rejected",
            });
            await finishCall({
                reason: "failed",
                toast: "\u041d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043a \u043c\u0438\u043a\u0440\u043e\u0444\u043e\u043d\u0443/\u043a\u0430\u043c\u0435\u0440\u0435",
            });
            return;
        }

        if (callRefs.localVideo) {
            callRefs.localVideo.srcObject = localStream;
            callRefs.localVideo.muted = true;
        }

        peerConnection = createPeerConnection();
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });

        try {
            await setRemoteDescriptionSafe(peerConnection, pendingOffer);
            await applyPendingCandidates();
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            deps.socket?.callAccept({
                session_id: sessionId,
                answer: peerConnection.localDescription,
            });

            currentCall.phase = "connecting";
            currentCall.pendingOffer = null;
            renderCallUi();
        } catch (error) {
            console.warn("failed to accept call", error);
            deps.socket?.callReject({
                session_id: sessionId,
                reason: "failed",
            });
            await finishCall({
                reason: "failed",
                toast: reasonText.failed,
            });
        }
    }

    async function rejectIncomingCall(reason = "rejected") {
        if (!currentCall) {
            return;
        }

        const sessionId = currentCall.sessionId;
        deps.socket?.callReject({
            session_id: sessionId,
            reason,
        });

        await finishCall({
            reason,
            toast: reasonText[reason] || reasonText.rejected,
        });
    }

    async function endCall(reason = "ended") {
        if (!currentCall) {
            return;
        }

        await finishCall({
            sendEndSignal: true,
            reason,
            toast: reasonText.ended,
        });
    }

    function toggleMute() {
        if (!currentCall || !localStream) {
            return;
        }
        const audioTracks = localStream.getAudioTracks();
        if (!audioTracks.length) {
            return;
        }

        const nextMuted = !currentCall.isMuted;
        audioTracks.forEach((track) => {
            track.enabled = !nextMuted;
        });
        currentCall.isMuted = nextMuted;
        updateMuteButton();
    }

    function toggleCamera() {
        if (!currentCall || currentCall.kind !== "video" || !localStream) {
            return;
        }

        const videoTracks = localStream.getVideoTracks();
        if (!videoTracks.length) {
            return;
        }

        const nextCameraOff = !currentCall.isCameraOff;
        videoTracks.forEach((track) => {
            track.enabled = !nextCameraOff;
        });
        currentCall.isCameraOff = nextCameraOff;
        updateCameraButton();
    }

    async function handleSocketCallInvite(payload = {}) {
        if (!payload.session_id || !payload.chat_id || !payload.offer) {
            return;
        }

        if (!supportsCalls()) {
            deps.socket?.callReject({
                session_id: payload.session_id,
                reason: "unsupported",
            });
            return;
        }

        if (currentCall) {
            deps.socket?.callReject({
                session_id: payload.session_id,
                reason: "busy",
            });
            return;
        }

        const peer = resolvePeerByChat(payload.chat_id, {
            userId: payload.from_user_id || null,
            name: payload.from_display_name || "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c",
            avatarUrl: "",
        });

        currentCall = {
            sessionId: payload.session_id,
            chatId: Number(payload.chat_id),
            kind: payload.kind === "video" ? "video" : "audio",
            direction: "incoming",
            phase: "ringing",
            peerUserId: peer.userId,
            peerName: peer.name,
            peerAvatar: peer.avatarUrl,
            pendingOffer: payload.offer,
            isMuted: false,
            isCameraOff: false,
        };

        renderCallUi();
        setMinimized(false);
        startRingtone("incoming");
        startRingTimer();
    }

    async function handleSocketCallAccept(payload = {}) {
        if (!currentCall || payload.session_id !== currentCall.sessionId || currentCall.direction !== "outgoing") {
            return;
        }

        if (!peerConnection || !payload.answer) {
            await finishCall({
                reason: "failed",
                toast: reasonText.failed,
            });
            return;
        }

        clearTimers();
        stopRingtone();

        try {
            await setRemoteDescriptionSafe(peerConnection, payload.answer);
            await applyPendingCandidates();
            currentCall.phase = "connecting";
            renderCallUi();
        } catch (error) {
            console.warn("failed to apply answer", error);
            await finishCall({
                sendEndSignal: true,
                reason: "failed",
                toast: reasonText.failed,
            });
        }
    }

    async function handleSocketCallReject(payload = {}) {
        if (!currentCall || payload.session_id !== currentCall.sessionId) {
            return;
        }

        const reason = String(payload.reason || "rejected").toLowerCase();
        await finishCall({
            reason,
            toast: reasonText[reason] || reasonText.rejected,
        });
    }

    async function handleSocketCallEnd(payload = {}) {
        if (!currentCall || payload.session_id !== currentCall.sessionId) {
            return;
        }

        const reason = String(payload.reason || "ended").toLowerCase();
        await finishCall({
            reason,
            toast: reasonText[reason] || reasonText.ended,
        });
    }

    async function handleSocketCallSignal(payload = {}) {
        if (!currentCall || payload.session_id !== currentCall.sessionId || !payload.candidate) {
            return;
        }

        if (!peerConnection) {
            pendingCandidates.push(payload.candidate);
            return;
        }

        if (!peerConnection.remoteDescription) {
            pendingCandidates.push(payload.candidate);
            return;
        }

        try {
            await peerConnection.addIceCandidate(payload.candidate);
        } catch (error) {
            console.warn("failed to add ICE candidate", error);
        }
    }

    function handleSocketCallError(payload = {}) {
        if (!payload?.error) {
            return;
        }
        helpers.showToast(payload.error);
    }

    function bindEvents() {
        bindRingtoneUnlockHandlers();

        callRefs.acceptBtn?.addEventListener("click", () => {
            unlockRingtoneAudio();
            void acceptIncomingCall();
        });

        callRefs.rejectBtn?.addEventListener("click", () => {
            void rejectIncomingCall("rejected");
        });

        callRefs.endBtn?.addEventListener("click", () => {
            void endCall("ended");
        });

        callRefs.muteBtn?.addEventListener("click", toggleMute);
        callRefs.cameraBtn?.addEventListener("click", toggleCamera);

        callRefs.minimizeBtn?.addEventListener("click", () => {
            setMinimized(true);
        });

        callRefs.expandFab?.addEventListener("click", () => {
            setMinimized(false);
        });

        refs.callActionBtn?.addEventListener("click", () => {
            unlockRingtoneAudio();
            void startCall("audio");
        });

        refs.videoActionBtn?.addEventListener("click", () => {
            unlockRingtoneAudio();
            void startCall("video");
        });
    }

    function attachDependencies(nextDeps) {
        deps.chats = nextDeps.chats;
        deps.socket = nextDeps.socket;
    }

    return {
        attachDependencies,
        bindEvents,
        startCall,
        endCall,
        onSocketCallInvite: handleSocketCallInvite,
        onSocketCallAccept: handleSocketCallAccept,
        onSocketCallReject: handleSocketCallReject,
        onSocketCallEnd: handleSocketCallEnd,
        onSocketCallSignal: handleSocketCallSignal,
        onSocketCallError: handleSocketCallError,
    };
}

