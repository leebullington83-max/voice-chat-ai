import * as THREE from 'three';
import { TalkingHead } from 'talkinghead';

document.addEventListener("DOMContentLoaded", async function () {
    const avatarContainer = document.getElementById('avatar-container');
    const loadingOverlay = document.getElementById('loading-overlay');
    const startButton = document.getElementById('startBtn');
    const stopButton = document.getElementById('stopBtn');
    const sessionStatus = document.getElementById('session-status');
    const transcript = document.getElementById('transcript');
    const characterSelect = document.getElementById('character-select');
    const voiceSelect = document.getElementById('voice-select');

    let head = null;
    let peerConnection = null;
    let dataChannel = null;
    let isSessionActive = false;

    // Populate personalities (run in parallel)
    async function loadPersonalities() {
        console.log("Loading personalities...");
        try {
            const response = await fetch('/characters');
            const data = await response.json();
            characterSelect.innerHTML = '';
            data.characters.forEach(char => {
                const option = document.createElement('option');
                option.value = char;
                option.textContent = char.replace(/_/g, ' ');
                characterSelect.appendChild(option);
            });
            characterSelect.value = "wizard"; // Default
            console.log("Personalities loaded:", data.characters);
        } catch (e) {
            console.error("Error loading characters:", e);
        }
    }
    loadPersonalities();

    // Initialize TalkingHead
    try {
        console.log("Initializing TalkingHead...");
        head = new TalkingHead(avatarContainer, {
            showLabels: false,
            cameraView: "upper",
            stats: false
        });

        const avatarUrl = "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@main/avatars/brunette.glb";
        console.log("Loading avatar model from:", avatarUrl);

        await head.showAvatar({
            url: avatarUrl,
            body: "F",
            avatarMood: "neutral"
        });

        loadingOverlay.style.display = 'none';
        console.log("Avatar loaded successfully");
    } catch (error) {
        console.error("Failed to initialize TalkingHead:", error);
        loadingOverlay.innerHTML = `<div style="padding:20px; text-align:center;"><p style="color:red; font-weight:bold;">Initialization Error</p><p style="font-size:0.8rem;">${error.message}</p></div>`;
    }

    // WebRTC Logic (Adapted from webrtc_realtime.js)
    async function startSession() {
        try {
            sessionStatus.textContent = "CONNECTING...";
            sessionStatus.className = "status-badge status-offline";
            startButton.disabled = true;

            const response = await fetch('/openai_ephemeral_key');
            const data = await response.json();
            const ephemeralKey = data.client_secret?.value;

            if (!ephemeralKey) throw new Error("No API key available");

            peerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            // Handle incoming audio
            peerConnection.ontrack = (e) => {
                console.log("WebRTC: Received AI audio track", e.track.kind);
                const audioStream = e.streams[0];

                // Link audio to avatar lip-sync
                if (head) {
                    console.log("Avatar: Attaching audio stream for lip-sync");
                    head.speakAudio(audioStream);
                }

                // Ensure the audio is actually played through speakers
                let audio = document.getElementById('ai-audio');
                if (!audio) {
                    audio = document.createElement('audio');
                    audio.id = 'ai-audio';
                    audio.autoplay = true;
                    audio.muted = false; // Explicitly ensure not muted
                    audio.volume = 1.0;  // Full volume
                    audio.style.display = 'none';
                    document.body.appendChild(audio);
                }
                
                // Keep ensured in case it was created without these
                audio.muted = false;
                audio.volume = 1.0;

                // Clone the stream to avoid conflicts between head and audio element
                const playStream = audioStream.clone();
                audio.srcObject = playStream;

                // Force play and log success/failure
                audio.play()
                    .then(() => console.log("Audio: Playback started successfully"))
                    .catch(err => {
                        console.error("Audio: Playback failed/blocked:", err);
                        addTranscript("Audio blocked by browser. Click anywhere on the page to enable sound.", "system");
                    });

                // Global resume for common audio contexts
                const resumeAudio = () => {
                   if (head && head.audioCtx && head.audioCtx.state === 'suspended') {
                       head.audioCtx.resume().then(() => console.log("AudioContext resumed"));
                   }
                };
                
                document.body.addEventListener('click', resumeAudio, { once: true });
                resumeAudio(); // Try immediately
            };

            // Setup Data Channel for text synchronization
            dataChannel = peerConnection.createDataChannel("oai-events");
            setupDataChannel();

            // Set up mic
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStream.getTracks().forEach(track => peerConnection.addTrack(track, micStream));

            // Create Offer
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            // Wait for ICE
            await new Promise(res => {
                if (peerConnection.iceGatheringState === 'complete') res();
                else peerConnection.addEventListener('icegatheringstatechange', () => {
                    if (peerConnection.iceGatheringState === 'complete') res();
                });
            });

            const model = "gpt-4o-realtime-preview-2024-12-17";
            const sdpResponse = await fetch(`/openai_realtime_proxy?model=${model}`, {
                method: "POST",
                body: peerConnection.localDescription.sdp,
                headers: { "Content-Type": "application/sdp" }
            });

            const answerSdp = await sdpResponse.text();
            await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });

            isSessionActive = true;
            sessionStatus.textContent = "ONLINE";
            sessionStatus.className = "status-badge status-online";
            stopButton.disabled = false;
            addTranscript("Session started. Your synthetic assistant is ready.", "system");

        } catch (error) {
            console.error("Session Start Error:", error);
            sessionStatus.textContent = "ERROR";
            startButton.disabled = false;
            addTranscript(`Error: ${error.message}`, "error");
        }
    }

    function setupDataChannel() {
        dataChannel.onopen = () => {
            const char = characterSelect.value;
            fetch(`/api/character/${char}`)
                .then(r => r.json())
                .then(instr => {
                    dataChannel.send(JSON.stringify({
                        type: "session.update",
                        session: {
                            instructions: instr,
                            voice: voiceSelect.value,
                            input_audio_transcription: { model: "whisper-1" }
                        }
                    }));
                });
        };

        dataChannel.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === "conversation.item.text.created") {
                addTranscript(msg.content.text, "ai");
            } else if (msg.type === "response.audio_transcript.delta") {
                // Could update text in real-time
            }
        };
    }

    function stopSession() {
        if (peerConnection) peerConnection.close();
        isSessionActive = false;
        sessionStatus.textContent = "DISCONNECTED";
        sessionStatus.className = "status-badge status-offline";
        startButton.disabled = false;
        stopButton.disabled = true;
        if (head) head.stopSpeaking();
    }

    function addTranscript(text, type) {
        const div = document.createElement('div');
        div.className = type + "-message";
        div.textContent = (type === "ai" ? "Assistant: " : "") + text;
        transcript.appendChild(div);
        transcript.scrollTop = transcript.scrollHeight;
    }

    startButton.addEventListener('click', startSession);
    stopButton.addEventListener('click', stopSession);
});
