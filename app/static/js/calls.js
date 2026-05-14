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
        ringing_out: "Ожидание ответа...",
        ringing_in: "Входящий вызов",
        connecting: "Подключение...",
        active: "Соединение установлено",
    };

    const reasonText = {
        rejected: "Звонок отклонен",
        busy: "Пользователь занят",
        offline: "Пользователь офлайн",
        ended: "Звонок завершен",
        disconnected: "Собеседник отключился",
        timeout: "Время ожидания истекло",
        failed: "Ошибка соединения",
        unsupported: "Звонки не поддерживаются в этом браузере",
        insecure_context: "\u0414\u043b\u044f \u0437\u0432\u043e\u043d\u043a\u043e\u0432 \u043d\u0443\u0436\u0435\u043d HTTPS (\u0438\u043b\u0438 localhost)",
    };

    const ringtonePatterns = {
        incoming: [
            { frequency: 659.25, duration: 0.16 },
            { frequency: 987.77, duration: 0.14 },
            { frequency: 1318.51, duration: 0.2 },
            { frequency: null, duration: 0.22 },
            { frequency: 880.0, duration: 0.14 },
            { frequency: 1318.51, duration: 0.16 },
            { frequency: 1760.0, duration: 0.24 },
            { frequency: null, duration: 0.74 },
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

        if (ringtoneContext.state === "suspended") {
            ringtoneContext.resume().catch(() => {});
        }

        return ringtoneContext;
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
            return;
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
    }

    function startRingtone(direction = "incoming") {
        stopRingtone();
        const pattern = ringtonePatterns[direction] || ringtonePatterns.incoming;
        playRingtonePattern(pattern);
    }

    function stopRingtone() {
        if (ringtoneLoopTimerId) {
            window.clearTimeout(ringtoneLoopTimerId);
            ringtoneLoopTimerId = null;
        }
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
    }

    function updateMuteButton() {
        if (!callRefs.muteBtn) {
            return;
        }

        const icon = callRefs.muteBtn.querySelector("i");
        callRefs.muteBtn.classList.toggle("is-active", Boolean(currentCall?.isMuted));
        callRefs.muteBtn.setAttribute("aria-label", currentCall?.isMuted ? "Включить микрофон" : "Выключить микрофон");

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
        callRefs.cameraBtn.setAttribute("aria-label", currentCall?.isCameraOff ? "Включить камеру" : "Выключить камеру");

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
            callRefs.modeBadge.textContent = currentCall.kind === "video" ? "Видеозвонок" : "Аудиозвонок";
        }
        if (callRefs.peerName) {
            callRefs.peerName.textContent = currentCall.peerName || "Пользователь";
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

        const timeoutSec = Math.max(15, Number(config.webrtcRingTimeoutSec) || 45);
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
                name: fallback.name || "Пользователь",
                avatarUrl: fallback.avatarUrl || "",
                isGroup: false,
            };
        }

        if (chat.is_group) {
            return {
                userId: fallback.userId || null,
                name: fallback.name || chat.title || "Группа",
                avatarUrl: fallback.avatarUrl || chat.avatar_url || "",
                isGroup: true,
            };
        }

        const peer = (chat.members || []).find((member) => member.id !== state.me?.id);
        return {
            userId: peer?.id || fallback.userId || null,
            name: peer?.display_name || chat.title || fallback.name || "Пользователь",
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
            helpers.showToast("Realtime-соединение еще не установлено");
            return;
        }

        if (currentCall) {
            helpers.showToast("Звонок уже выполняется");
            return;
        }

        if (!state.currentChatId) {
            helpers.showToast("Сначала выберите чат");
            return;
        }

        const chat = deps.chats?.getChatById(state.currentChatId);
        if (!chat) {
            helpers.showToast("Чат не найден");
            return;
        }

        if (chat.is_group) {
            helpers.showToast("Групповые звонки пока не поддерживаются");
            return;
        }

        const peer = resolvePeerByChat(chat.id);
        if (!peer.userId) {
            helpers.showToast("Не удалось определить собеседника");
            return;
        }

        try {
            localStream = await acquireLocalStream(kind);
        } catch (error) {
            helpers.showToast("Нет доступа к микрофону/камере");
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
                toast: "Нет доступа к микрофону/камере",
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
            name: payload.from_display_name || "Пользователь",
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
        callRefs.acceptBtn?.addEventListener("click", () => {
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
            void startCall("audio");
        });

        refs.videoActionBtn?.addEventListener("click", () => {
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
