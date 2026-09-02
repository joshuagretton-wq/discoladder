// Swappable voice-provider interface.
// v1 = OpenAI Realtime (fused speech-to-speech, native barge-in over server VAD).
// A future ElevenLabs provider can implement the same connect()/disconnect() shape
// and emit the same callbacks — nothing else in the app needs to change.

export class OpenAIRealtimeProvider {
  /**
   * @param {object} opts
   * @param {(state: string, detail?: string) => void} opts.onStatus
   * @param {(who: "you"|"buyer", text: string, final: boolean) => void} opts.onTranscript
   */
  constructor({ onStatus = () => {}, onTranscript = () => {}, onLevels = () => {}, persona = "" } = {}) {
    this.onStatus = onStatus;
    this.onTranscript = onTranscript;
    this.onLevels = onLevels; // (youLevel, buyerLevel) each 0..1, ~60fps
    this.persona = persona;
    this.pc = null;
    this.dc = null;
    this.micStream = null;
    this.audioEl = null;
    // Audio-level metering (drives the speaking visualizer).
    // Only the LOCAL mic is tapped with Web Audio; the remote stream is left
    // untouched so playback can't be silenced. The buyer orb pulses off events.
    this.audioCtx = null;
    this._anYou = null;
    this._buyerPulse = 0;
    this._meterRAF = null;
    this._greeted = false; // have we asked the buyer to open the call yet?
    // Buyer-caption pacing state (see _startBuyerPacer).
    this._buyerTarget = "";
    this._buyerShown = 0;
    this._buyerDone = false;
    this._buyerPacer = null;
  }

  async connect() {
    this.onStatus("connecting");

    // 1. Get a short-lived ephemeral token from our server (persona-configured).
    const q = this.persona ? `?persona=${encodeURIComponent(this.persona)}` : "";
    const sessionRes = await fetch("/api/session" + q);
    const session = await sessionRes.json();
    if (!sessionRes.ok) throw new Error(session.error || "Could not start session.");
    const { client_secret, model } = session;

    // 2. Peer connection + remote audio playback.
    const pc = new RTCPeerConnection();
    this.pc = pc;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Autoplay policies suspend the context until a user gesture; Start is one.
    if (this.audioCtx.state === "suspended") this.audioCtx.resume();

    this.audioEl = new Audio();
    this.audioEl.autoplay = true;
    this.audioEl.playsInline = true;
    this.audioEl.style.display = "none";
    document.body.appendChild(this.audioEl); // some browsers won't play a detached element
    pc.ontrack = (e) => {
      this.audioEl.srcObject = e.streams[0];
      this.audioEl.play().catch(() => {}); // explicit play() — autoplay alone can be blocked
    };

    // 3. Mic in.
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(this.micStream.getTracks()[0], this.micStream);
    this._anYou = this._meterFor(this.micStream); // your mic level
    this._startMeterLoop();

    // 4. Data channel for realtime events (transcripts, etc.).
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("message", (e) => this._handleEvent(JSON.parse(e.data)));
    dc.addEventListener("open", () => {
      // Fallback: greet even if we never see a session.created event.
      setTimeout(() => this._greet(), 1200);
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") this.onStatus("connected");
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.onStatus("ended");
      }
    });

    // 5. SDP handshake with the Realtime endpoint using the ephemeral token.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // GA Realtime WebRTC handshake. Model is already set in the session, so no query param.
    const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${client_secret}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdpRes.ok) throw new Error("Voice handshake failed: " + (await sdpRes.text()));

    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
  }

  _handleEvent(evt) {
    switch (evt.type) {
      // Session is configured and ready — have the buyer open the call.
      case "session.created":
      case "session.updated":
        this._greet();
        break;
      // Buyer (assistant) speech. The model emits the transcript far faster than the
      // audio plays, so we don't render deltas directly — we feed them to a pacer that
      // reveals text at roughly speaking rate, trailing the voice like real captions.
      // GA uses response.output_audio_transcript.*; older beta used response.audio_transcript.*.
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this._buyerTarget += evt.delta || "";
        this._buyerPulse = 0.9; // flash the buyer orb while it's talking
        this._startBuyerPacer();
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (evt.transcript) this._buyerTarget = evt.transcript;
        this._buyerDone = true;
        this._startBuyerPacer();
        break;
      // Your speech, transcribed after each turn.
      case "conversation.item.input_audio_transcription.completed":
        this.onTranscript("you", evt.transcript || "", true);
        break;
      case "error":
        this.onStatus("error", evt.error?.message || "Realtime error");
        break;
    }
  }

  // Ask the buyer to speak first (open the call). Guarded so it fires once.
  _greet() {
    if (this._greeted || !this.dc || this.dc.readyState !== "open") return;
    this._greeted = true;
    try { this.dc.send(JSON.stringify({ type: "response.create" })); } catch {}
  }

  // Reveal the buyer's transcript at ~speaking pace so captions trail the voice.
  // Advance ~1 char/tick when caught up; speed up if a backlog builds, so the text
  // lags the audio by only a small, steady amount and finishes just after they stop.
  _startBuyerPacer() {
    if (this._buyerPacer) return;
    this._buyerPacer = setInterval(() => {
      const backlog = this._buyerTarget.length - this._buyerShown;
      if (backlog <= 0) {
        if (this._buyerDone) this._finishBuyerTurn();
        return;
      }
      const step = Math.max(1, Math.floor(backlog / 15));
      this._buyerShown = Math.min(this._buyerTarget.length, this._buyerShown + step);
      this.onTranscript("buyer", this._buyerTarget.slice(0, this._buyerShown), false);
    }, 55);
  }

  _finishBuyerTurn() {
    this._stopBuyerPacer();
    this.onTranscript("buyer", this._buyerTarget, true);
    this._buyerTarget = "";
    this._buyerShown = 0;
    this._buyerDone = false;
  }

  _stopBuyerPacer() {
    if (this._buyerPacer) {
      clearInterval(this._buyerPacer);
      this._buyerPacer = null;
    }
  }

  // Build an analyser tapping a stream's audio energy (does not route to output).
  _meterFor(stream) {
    const src = this.audioCtx.createMediaStreamSource(stream);
    const an = this.audioCtx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.6;
    src.connect(an); // analyser is a sink — no connection to destination, no echo
    an.__buf = new Uint8Array(an.frequencyBinCount);
    return an;
  }

  _level(an) {
    if (!an) return 0;
    an.getByteTimeDomainData(an.__buf);
    let sum = 0;
    for (let i = 0; i < an.__buf.length; i++) {
      const v = (an.__buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / an.__buf.length) * 3.5); // RMS, scaled to ~0..1
  }

  _startMeterLoop() {
    if (this._meterRAF) return;
    const tick = () => {
      this._buyerPulse *= 0.86; // decay the buyer flash between transcript events
      this.onLevels(this._level(this._anYou), this._buyerPulse);
      this._meterRAF = requestAnimationFrame(tick);
    };
    this._meterRAF = requestAnimationFrame(tick);
  }

  disconnect() {
    this._stopBuyerPacer();
    if (this._meterRAF) { cancelAnimationFrame(this._meterRAF); this._meterRAF = null; }
    this._anYou = null;
    this._buyerPulse = 0;
    try { this.audioCtx?.close(); } catch {}
    this.audioCtx = null;
    this.onLevels(0, 0);
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl.remove(); }
    this.pc = null;
    this.dc = null;
    this.micStream = null;
    this.onStatus("ended");
  }
}
