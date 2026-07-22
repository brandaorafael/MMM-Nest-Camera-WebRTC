Module.register("MMM-Nest-Camera-WebRTC", {
	defaults: {
		// Legacy single-camera keys (still supported for back-compat)
		width: "33%",
		nestClientId: '',
		nestClientSecret: '',
		nestCode: '',
		nestProjectId: '',
		nestDeviceId: '',

		// Multi-camera
		cameras: [],            // [{ name, nestDeviceId, width?, extendInterval?, reconnectDelay? }]
		autoFetchNames: true,   // pull each camera's name from the Google Home app (SDM API); overrides the config `name`. Falls back to config `name` when a device has no fetchable name.
		layout: "hero",         // 'hero' now; 'grid' | 'carousel' | 'focus' are Phase 3 stubs
		cycleInterval: 0,       // ms; 0 = off. Rotates the hero camera automatically.
		heroWidth: null,        // falls back to `width`
		thumbWidth: "15%",

		// Motion-driven auto-focus (optional; requires Google Cloud Pub/Sub — see MOTION-EVENTS-SETUP.md)
		enableMotionFocus: false,
		pubsubSubscription: "",  // e.g. "projects/<gcp-project>/subscriptions/nest-events-sub"
		pubsubKeyFile: "",       // service-account JSON, relative to the module folder
		motionHoldMs: 20000,     // keep the triggered camera as hero / flag its thumbnail this long

		// Event history panel (chronological log of motion/doorbell events)
		showEventHistory: false,
		historyPosition: "top_left",   // any MagicMirror region: top_left, top_right, top_center, …
		historyMaxEntries: 20,         // max rows shown
		historyMaxAgeMs: 86400000,     // drop entries older than this (24h); 0 = no age limit
		historyTitle: "Event History",
		historyFontSize: "",           // CSS size (e.g. "1.5em", "22px"); blank = stylesheet default

		reconnectDelay: 3000,
		extendInterval: 240000  // must be < 300000 (Nest sessions expire at 5 min)
	},

	getStyles() {
		return [`${this.name}.css`];
	},

	async start() {
		// Module-level (account-scoped) state — one Google account = one token
		this.cameras = {};        // keyed by cameraId
		this.cameraOrder = [];     // ordered cameraIds
		this.token = null;
		this.refreshToken = null;
		this.tokenRequested = false;
		this.needsAuth = false;    // account-level auth gate
		this.authUrl = null;
		this.heroId = null;
		this.cycleTimer = null;
		this.suspended = false;
		this.suspendedForUserPresence = false;
		// True once the user takes manual control (keyboard/web/notification); while
		// true, motion events flag thumbnails but never steal the hero. Reset on resume.
		this.manualPinned = false;
		this.motionResumeTimer = null;
		this.eventHistory = [];    // [{name, kind, label, at}] newest last; seeded from node_helper

		this.normalizeCameras();
		this.startInputControl();   // keyboard / wireless-remote control (always listening)
		this.startEventStream();    // motion/doorbell auto-focus (if enabled + configured)
		this.startEventHistory();   // load persisted event history (if enabled)

		if (this.data.hiddenOnStartup) {
			// Don't connect if module is going to be hidden
			this.suspended = true;
			this.pushControlState();
			return;
		}
		await this.initAllCameras();
		this.startCycle();
		this.startStallWatch();
		this.pushControlState();
	},

	// Relay a message to node_helper so it lands in magicmirror.log — frontend
	// Log.* only reaches the renderer console, so self-healing actions would
	// otherwise be invisible on the Pi.
	serverLog(msg) {
		this.sendSocketNotification("CLIENT_LOG", { msg });
	},

	// ---------------------------------------------------------------------------
	// Frozen-video watchdog
	//
	// A WebRTC video can stall (decoder freezes in Electron) while the track still
	// reports "live"/unmuted, so mute-based No-Signal detection misses it. We watch
	// the decoded-frame counter: if a connected camera stops producing new frames
	// for ~STALL_LIMIT checks, we reconnect just that camera — self-healing without
	// restarting MagicMirror.
	// ---------------------------------------------------------------------------

	startStallWatch() {
		if (this._stallTimer) clearInterval(this._stallTimer);
		this._stallTimer = setInterval(() => this.checkStalls(), 7000);
	},

	stopStallWatch() {
		if (this._stallTimer) {
			clearInterval(this._stallTimer);
			this._stallTimer = null;
		}
	},

	decodedFrames(video) {
		try {
			if (typeof video.getVideoPlaybackQuality === "function") {
				return video.getVideoPlaybackQuality().totalVideoFrames || 0;
			}
		} catch (e) { /* ignore */ }
		return video.webkitDecodedFrameCount || 0;
	},

	checkStalls() {
		if (this.suspended) return;
		const STALL_LIMIT = 3; // 3 × 7s ≈ 21s with no new frames → treat as frozen
		for (const cameraId of this.cameraOrder) {
			const cam = this.cameras[cameraId];
			const v = cam.video;
			const playing = cam.pc && cam.pc.connectionState === "connected"
				&& cam.stream && !cam.noSignal && v && v.videoWidth > 0;
			if (!playing) {
				cam.stallCount = 0;
				continue;
			}
			// A tile paused by DOM re-parenting keeps decoding frames but shows a
			// frozen image — resume it. (Frame-count stall detection below handles a
			// genuinely dead decoder, which no play() can fix.)
			if (v.paused) {
				this.serverLog(`${cam.name} video was paused; resuming`);
				v.play().catch(() => {});
			}
			const frames = this.decodedFrames(v);
			if (frames > cam.lastFrames) {
				cam.lastFrames = frames;
				cam.stallCount = 0;
			} else if (cam.lastFrames > 0) {
				// It was rendering frames and has now stopped — count consecutive stalls.
				cam.stallCount++;
				if (cam.stallCount >= STALL_LIMIT) {
					this.serverLog(`${cam.name} video frozen (no new frames); reconnecting`);
					cam.stallCount = 0;
					cam.lastFrames = 0;
					this.cleanupConnection(cameraId);
					if (this.heroId === cameraId) this.ensureViewableHero();
					this.initializeRTCPeerConnection(cameraId);
				}
			}
		}
	},

	// ---------------------------------------------------------------------------
	// Config normalization
	// ---------------------------------------------------------------------------

	normalizeCameras() {
		const account = {
			nestProjectId: this.config.nestProjectId,
			nestClientId: this.config.nestClientId,
			nestClientSecret: this.config.nestClientSecret,
			nestCode: this.config.nestCode
		};

		// Multi-camera config, or fall back to legacy single-camera keys
		const list = Array.isArray(this.config.cameras) && this.config.cameras.length
			? this.config.cameras
			: (this.config.nestDeviceId ? [{name: "Camera", nestDeviceId: this.config.nestDeviceId}] : []);

		list.forEach((c, i) => {
			const cfg = {
				name: c.name || `Camera ${i + 1}`,
				nestDeviceId: c.nestDeviceId,
				nestProjectId: c.nestProjectId || account.nestProjectId,
				nestClientId: c.nestClientId || account.nestClientId,
				nestClientSecret: c.nestClientSecret || account.nestClientSecret,
				nestCode: c.nestCode || account.nestCode,
				extendInterval: c.extendInterval || this.config.extendInterval,
				reconnectDelay: c.reconnectDelay || this.config.reconnectDelay
			};

			const required = ["nestProjectId", "nestDeviceId", "nestClientId", "nestClientSecret"];
			for (const key of required) {
				if (!cfg[key]) {
					Log.warn(`[${this.name}] camera "${cfg.name}" missing required config option: ${key}`);
				}
			}

			const cameraId = `${this.identifier}__${i}`;
			this.cameras[cameraId] = this.makeCameraState(cameraId, cfg);
			this.cameraOrder.push(cameraId);
		});

		if (this.cameraOrder.length && !this.heroId) {
			this.heroId = this.cameraOrder[0];
		}
	},

	makeCameraState(cameraId, config) {
		return {
			cameraId,
			config,
			name: config.name,
			pc: null,
			stream: null,
			video: null,
			wrapper: null,
			canvas: null,
			needsAuth: false,
			authUrl: null,
			tokenExpired: false,
			noSignal: false,
			reconnectTimeout: null,
			disconnectTimeout: null,
			noSignalRetryInterval: null,
			pingIntervalId: null,
			// True while we tear the connection down on purpose, so the ping
			// channel's onclose doesn't schedule a competing reconnect.
			deliberateClose: false,
			// Frozen-video watchdog: last decoded-frame count and consecutive stalls.
			lastFrames: 0,
			stallCount: 0,
			// Motion/doorbell event flag (thumbnail ring + text badge)
			eventFlag: null,        // null | 'motion' | 'doorbell'
			eventLabel: null,       // 'PERSON' | 'MOTION' | 'DOORBELL'
			eventFlagTimer: null,
			eventIconEl: null,
			// Audio visualizer (hero only)
			audioCtx: null,
			analyser: null,
			audioSource: null,
			animFrameId: null
		};
	},

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	async initAllCameras() {
		for (const cameraId of this.cameraOrder) {
			await this.initializeRTCPeerConnection(cameraId);
		}
	},

	cleanupAllCameras() {
		for (const cameraId of this.cameraOrder) {
			this.cleanupConnection(cameraId);
		}
	},

	async suspend() {
		this.suspended = true;
		this.stopCycle();
		this.cleanupAllCameras();
	},

	async resume() {
		this.suspended = false;
		await this.initAllCameras();
		this.startCycle();
	},

	stop() {
		this.stopCycle();
		this.stopStallWatch();
		this.stopInputControl();
		if (this.motionResumeTimer) {
			clearTimeout(this.motionResumeTimer);
			this.motionResumeTimer = null;
		}
		for (const id of this.cameraOrder) {
			const cam = this.cameras[id];
			if (cam.eventFlagTimer) { clearTimeout(cam.eventFlagTimer); cam.eventFlagTimer = null; }
		}
		if (this._historyRefreshTimer) {
			clearInterval(this._historyRefreshTimer);
			this._historyRefreshTimer = null;
		}
		if (this._historyEl && this._historyEl.parentNode) {
			this._historyEl.parentNode.removeChild(this._historyEl);
			this._historyEl = null;
		}
		this.cleanupAllCameras();
	},

	cleanupConnection(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		cam.deliberateClose = true;
		if (cam.reconnectTimeout) {
			clearTimeout(cam.reconnectTimeout);
			cam.reconnectTimeout = null;
		}
		if (cam.disconnectTimeout) {
			clearTimeout(cam.disconnectTimeout);
			cam.disconnectTimeout = null;
		}
		if (cam.pingIntervalId) {
			clearInterval(cam.pingIntervalId);
			cam.pingIntervalId = null;
		}
		this.cleanupAudio(cameraId);
		if (cam.stream) {
			cam.stream.getTracks().forEach((track) => track.stop());
			cam.stream = null;
		}
		if (cam.pc) {
			cam.pc.close();
			cam.pc = null;
		}
		if (cam.video) {
			cam.video.srcObject = null;
			cam.video = null;
		}
		cam.canvas = null;
		cam.wrapper = null;
		cam.eventIconEl = null;   // wrapper is gone; icon will be rebuilt on next render
		cam.noSignal = false;
		this.stopNoSignalRetry(cameraId);
	},

	cleanupAudio(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		if (cam.animFrameId) {
			cancelAnimationFrame(cam.animFrameId);
			cam.animFrameId = null;
		}
		if (cam.audioSource) {
			cam.audioSource.disconnect();
			cam.audioSource = null;
		}
		if (cam.analyser) {
			cam.analyser.disconnect();
			cam.analyser = null;
		}
		if (cam.audioCtx) {
			cam.audioCtx.close();
			cam.audioCtx = null;
		}
	},

	// ---------------------------------------------------------------------------
	// Audio visualizer (hero camera only)
	// ---------------------------------------------------------------------------

	startAudioVisualizer(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		if (cameraId !== this.heroId) return;   // only the hero tile shows an equalizer
		if (cam.audioCtx) return;               // already running
		const audioTracks = cam.stream ? cam.stream.getAudioTracks() : [];
		if (!audioTracks.length || !cam.canvas) return;

		try {
			cam.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			cam.analyser = cam.audioCtx.createAnalyser();
			cam.analyser.fftSize = 64;
			cam.analyser.smoothingTimeConstant = 0.85;
			cam.analyser.minDecibels = -70;

			// Connect the stream's audio to the analyser without routing to speakers
			const silentStream = new MediaStream(audioTracks);
			cam.audioSource = cam.audioCtx.createMediaStreamSource(silentStream);
			cam.audioSource.connect(cam.analyser);
			// Intentionally NOT connecting analyser to audioCtx.destination → stays silent

			this.drawEqualizer(cameraId);
		} catch (e) {
			Log.warn(`${this.name} audio visualizer init failed:`, e);
		}
	},

	drawEqualizer(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam || !cam.analyser || !cam.canvas) return;

		const canvas = cam.canvas;
		const ctx = canvas.getContext("2d");
		const bufferLength = cam.analyser.frequencyBinCount;
		const dataArray = new Uint8Array(bufferLength);

		const BAR_COUNT = 10;
		const BAR_GAP = 3;

		const draw = () => {
			cam.animFrameId = requestAnimationFrame(draw);
			if (!cam.analyser || !canvas.isConnected) return;

			cam.analyser.getByteFrequencyData(dataArray);

			const W = canvas.width;
			const H = canvas.height;
			ctx.clearRect(0, 0, W, H);

			const barW = (W - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
			const step = Math.floor(bufferLength / BAR_COUNT);

			for (let i = 0; i < BAR_COUNT; i++) {
				// Average a small bucket of frequency bins per bar
				let sum = 0;
				for (let j = 0; j < step; j++) sum += dataArray[i * step + j];
				const avg = sum / step;

				const barH = Math.max(2, (avg / 255) * H);
				const x = i * (barW + BAR_GAP);
				const y = H - barH;

				// Gradient: cyan at bottom fading to white at top
				const grad = ctx.createLinearGradient(0, H, 0, 0);
				grad.addColorStop(0, "rgba(100, 220, 255, 0.9)");
				grad.addColorStop(1, "rgba(255, 255, 255, 0.6)");

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.roundRect(x, y, barW, barH, 2);
				ctx.fill();
			}
		};

		draw();
	},

	// ---------------------------------------------------------------------------
	// No-signal recovery (per camera)
	// ---------------------------------------------------------------------------

	startNoSignalRetry(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam || cam.noSignalRetryInterval) return;
		cam.noSignalRetryInterval = setInterval(async () => {
			if (!cam.noSignal || this.suspended) return;
			Log.log(`${this.name} no signal retry: reconnecting ${cam.name}`);
			this.cleanupConnection(cameraId);
			await this.initializeRTCPeerConnection(cameraId);
		}, 30000);
	},

	stopNoSignalRetry(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		if (cam.noSignalRetryInterval) {
			clearInterval(cam.noSignalRetryInterval);
			cam.noSignalRetryInterval = null;
		}
	},

	// ---------------------------------------------------------------------------
	// Auto-cycle + hero selection
	// ---------------------------------------------------------------------------

	startCycle() {
		this.stopCycle();
		const interval = this.config.cycleInterval;
		if (!interval || interval <= 0) return;
		if (this.cameraOrder.length <= 1) return;
		this.cycleTimer = setInterval(() => {
			if (this.suspended) return;
			this.advanceHero(1);
		}, interval);
	},

	stopCycle() {
		if (this.cycleTimer) {
			clearInterval(this.cycleTimer);
			this.cycleTimer = null;
		}
	},

	// A camera can be the hero only if it's actually displaying live video.
	isViewable(cameraId) {
		const c = this.cameras[cameraId];
		return !!(c && c.pc && c.stream && !c.noSignal && !c.tokenExpired);
	},

	advanceHero(step) {
		const ids = this.cameraOrder;
		if (ids.length <= 1) return;
		const start = ids.indexOf(this.heroId);
		// Walk in the requested direction to the next VIEWABLE camera, skipping
		// any that are offline / No Signal so a dead feed never becomes the hero.
		for (let i = 1; i <= ids.length; i++) {
			const idx = (((start + step * i) % ids.length) + ids.length) % ids.length;
			if (idx === start) break;
			if (this.isViewable(ids[idx])) {
				this.setHero(ids[idx]);
				return;
			}
		}
		// No other viewable camera — leave the hero where it is.
	},

	// If the current hero can't display (offline / No Signal / still connecting),
	// hand the hero spot to the first camera that is actually streaming.
	ensureViewableHero() {
		if (this.isViewable(this.heroId)) return;
		const firstViewable = this.cameraOrder.find((id) => this.isViewable(id));
		if (firstViewable) this.setHero(firstViewable);
	},

	setHero(cameraId) {
		if (!this.cameras[cameraId] || this.heroId === cameraId) return;
		this.heroId = cameraId;
		// updateDom re-renders; renderCameraTile reuses cached <video> elements (no stream
		// restart) and _syncEqualizer moves the equalizer to the new hero.
		this.updateDom();
	},

	resolveCameraId(payload) {
		if (payload == null) return null;
		if (typeof payload === "number") return this.cameraOrder[payload] || null;
		if (typeof payload === "string") {
			if (this.cameras[payload]) return payload;
			const byName = this.cameraOrder.find((id) => this.cameras[id].name === payload);
			if (byName) return byName;
			const asIdx = parseInt(payload, 10);
			if (!isNaN(asIdx) && this.cameraOrder[asIdx]) return this.cameraOrder[asIdx];
		}
		if (typeof payload === "object") {
			if (payload.cameraId && this.cameras[payload.cameraId]) return payload.cameraId;
			if (payload.name) {
				const id = this.cameraOrder.find((i) => this.cameras[i].name === payload.name);
				if (id) return id;
			}
			if (typeof payload.index === "number") return this.cameraOrder[payload.index] || null;
		}
		return null;
	},

	// ---------------------------------------------------------------------------
	// Input control (keyboard / wireless remote / self-hosted web page)
	//
	// Every input source — the physical keyboard/remote, the web control page
	// (node_helper → CONTROL_CMD), and the inter-module NEST_CAM_* notifications —
	// funnels through applyControl() so they all behave identically.
	// ---------------------------------------------------------------------------

	applyControl(action, target) {
		switch (action) {
			case "next":
				this.pinManual();        // a manual pick sticks; resume re-enables cycling
				this.advanceHero(1);
				break;
			case "prev":
				this.pinManual();
				this.advanceHero(-1);
				break;
			case "set": {
				const id = this.resolveCameraId(target);
				if (id) {
					this.pinManual();
					this.setHero(id);
				}
				break;
			}
			case "pause":
				this.pinManual();
				break;
			case "resume":
				this.releaseManual();
				this.startCycle();
				break;
			case "toggle-cycle":
				if (this.cycleTimer) { this.pinManual(); }
				else { this.releaseManual(); this.startCycle(); }
				break;
			default:
				return;
		}
		// Reflect the new hero / pause state on-screen. next/prev/set already
		// re-render via setHero, but pause/resume/toggle-cycle don't — so the
		// top-left mode mark would go stale without this.
		this.updateDom();
		this.pushControlState();
	},

	// Enter manual control: stop auto-cycle and cancel any pending motion hold so
	// motion events flag thumbnails without stealing the hero.
	pinManual() {
		this.manualPinned = true;
		this.stopCycle();
		if (this.motionResumeTimer) {
			clearTimeout(this.motionResumeTimer);
			this.motionResumeTimer = null;
		}
	},

	releaseManual() {
		this.manualPinned = false;
	},

	// A physical keyboard, wireless numpad, or presentation clicker plugged into
	// the Pi shows up as keydown events in the Electron renderer. No extra module
	// or driver needed. Number keys jump to a camera; arrows/PageUp-Down cycle;
	// space toggles auto-cycle.
	startInputControl() {
		if (this._keyHandler) return;
		this._keyHandler = (e) => {
			let handled = true;
			switch (e.key) {
				case "ArrowRight":
				case "ArrowDown":
				case "PageDown":
				case "n":
					this.applyControl("next");
					break;
				case "ArrowLeft":
				case "ArrowUp":
				case "PageUp":
				case "p":
					this.applyControl("prev");
					break;
				case " ":
				case "Spacebar":
					this.applyControl("toggle-cycle");
					break;
				default:
					// Keys 1-9 → focus that camera (1 = first camera)
					if (/^[1-9]$/.test(e.key)) this.applyControl("set", parseInt(e.key, 10) - 1);
					else handled = false;
			}
			if (handled) e.preventDefault();
		};
		document.addEventListener("keydown", this._keyHandler);
	},

	stopInputControl() {
		if (this._keyHandler) {
			document.removeEventListener("keydown", this._keyHandler);
			this._keyHandler = null;
		}
	},

	// Push the current roster + hero + cycle state to node_helper, which serves it
	// to the web control page (/nest-cam) so the page can render live buttons.
	pushControlState() {
		this.sendSocketNotification("CONTROL_STATE", {
			identifier: this.identifier,
			moduleName: this.name,
			cyclePaused: !this.cycleTimer,
			cycleConfigured: (this.config.cycleInterval > 0) && (this.cameraOrder.length > 1),
			cameras: this.cameraOrder.map((id, i) => ({
				index: i,
				name: this.cameras[id].name,
				viewable: this.isViewable(id),
				isHero: id === this.heroId
			}))
		});
	},

	// ---------------------------------------------------------------------------
	// Motion-driven auto-focus (optional; Google Cloud Pub/Sub events)
	//
	// node_helper pulls SDM camera events and relays them as NEST_EVENT{deviceId,kind}.
	// "Manual wins": if the user has pinned a camera, motion only flags the thumbnail
	// (pulsing ring + corner icon) and never steals the hero. In auto-cycle mode, the
	// triggered camera is promoted to hero for motionHoldMs, then auto-cycle resumes.
	// ---------------------------------------------------------------------------

	startEventStream() {
		if (!this.config.enableMotionFocus) return;
		if (!this.config.pubsubSubscription || !this.config.pubsubKeyFile) {
			Log.warn(`${this.name} enableMotionFocus is on but pubsubSubscription/pubsubKeyFile are not set`);
			return;
		}
		this.sendSocketNotification("INIT_EVENTS", {
			subscription: this.config.pubsubSubscription,
			keyFile: this.config.pubsubKeyFile
		});
	},

	handleMotionEvent(cameraId, kind, label, opts) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		const hold = this.config.motionHoldMs || 20000;
		const record = !opts || opts.record !== false;   // synthetic test events pass record:false

		// 1. Flag the thumbnail (always — even under manual control, so you notice).
		cam.eventFlag = (kind === "doorbell") ? "doorbell" : "motion";
		cam.eventLabel = label || (kind === "doorbell" ? "DOORBELL" : "MOTION");

		// Record it in the event history (persistence is handled by node_helper).
		if (record) {
			this.eventHistory.push({ deviceId: cam.config.nestDeviceId, name: cam.name, kind, label: cam.eventLabel, at: (opts && opts.at) || Date.now() });
			if (this.eventHistory.length > 500) this.eventHistory = this.eventHistory.slice(-500);
			this.renderEventHistory();
		}
		if (cam.eventFlagTimer) clearTimeout(cam.eventFlagTimer);
		cam.eventFlagTimer = setTimeout(() => {
			cam.eventFlag = null;
			cam.eventLabel = null;
			cam.eventFlagTimer = null;
			this.updateDom();
			this.pushControlState();
		}, hold);

		this.serverLog(`${kind} event on ${cam.name}${this.manualPinned ? " (flagged; manual focus active)" : " (auto-focusing)"}`);

		// 2. Auto-focus only in auto-cycle mode and only if the camera can display.
		if (!this.manualPinned && this.isViewable(cameraId)) {
			this.stopCycle();               // hold the triggered camera as hero…
			this.setHero(cameraId);
			if (this.motionResumeTimer) clearTimeout(this.motionResumeTimer);
			this.motionResumeTimer = setTimeout(() => {
				this.motionResumeTimer = null;
				if (!this.manualPinned) this.startCycle();   // …then resume cycling
			}, hold);
		}

		this.updateDom();
		this.pushControlState();
	},

	// Adds/removes the event ring class + text badge on a camera's live tile,
	// mirroring cam.eventFlag. Called from renderCameraTile (fresh + reuse paths).
	// Uses a text badge (not an emoji) — the Pi's Electron has no colour-emoji font,
	// so 🏃/🔔 render as tofu boxes.
	_syncEventFlag(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam || !cam.wrapper) return;
		const w = cam.wrapper;
		w.classList.remove("rtw-event-motion", "rtw-event-doorbell");
		if (cam.eventIconEl && cam.eventIconEl.parentNode) {
			cam.eventIconEl.parentNode.removeChild(cam.eventIconEl);
		}
		cam.eventIconEl = null;
		if (cam.eventFlag) {
			w.classList.add(cam.eventFlag === "doorbell" ? "rtw-event-doorbell" : "rtw-event-motion");
			const badge = document.createElement("div");
			badge.classList.add("rtw-event-badge");
			// filled dot (● U+25CF renders everywhere) + uppercase label, no emoji
			badge.textContent = `● ${cam.eventLabel || (cam.eventFlag === "doorbell" ? "DOORBELL" : "MOTION")}`;
			w.appendChild(badge);
			cam.eventIconEl = badge;
		}
	},

	// Adds/removes the auto-play / paused status mark in the HERO tile's top-left
	// corner, mirroring this.manualPinned: pinned = "PAUSED", otherwise "AUTO".
	// Only shown when auto-cycling is actually possible (interval set + >1 camera),
	// since with a single camera or cycling off there's no mode to convey. Uses a
	// CSS-drawn icon (not an emoji) — the Pi's Electron has no colour-emoji font.
	// Called from renderCameraTile (fresh + reuse paths).
	_syncModeBadge(cameraId, isHero) {
		const cam = this.cameras[cameraId];
		if (!cam || !cam.wrapper) return;
		if (cam.modeEl && cam.modeEl.parentNode) {
			cam.modeEl.parentNode.removeChild(cam.modeEl);
		}
		cam.modeEl = null;
		const cycleConfigured = (this.config.cycleInterval > 0) && (this.cameraOrder.length > 1);
		if (!isHero || !cycleConfigured) return;
		const paused = !!this.manualPinned;
		const mark = document.createElement("div");
		mark.className = `rtw-mode ${paused ? "rtw-mode-paused" : "rtw-mode-auto"}`;
		const icon = document.createElement("span");
		icon.className = "rtw-mode-icon";
		const text = document.createElement("span");
		text.className = "rtw-mode-text";
		text.textContent = paused ? "PAUSED" : "AUTO";
		mark.append(icon, text);
		cam.wrapper.appendChild(mark);
		cam.modeEl = mark;
	},

	// ---------------------------------------------------------------------------
	// Event history panel (rendered into a configurable MagicMirror region)
	//
	// node_helper is the source of truth: it persists every event to disk and
	// replies to GET_HISTORY. The frontend seeds from that on start, appends new
	// events live, and renders a chronological panel into config.historyPosition.
	// ---------------------------------------------------------------------------

	startEventHistory() {
		if (!this.config.showEventHistory) return;
		// Ask node_helper for the persisted history; it replies HISTORY_<identifier>.
		this.sendSocketNotification("GET_HISTORY", { identifier: this.identifier });
		// Render an (empty) panel immediately so the region isn't blank while we wait.
		this.renderEventHistory();
		// Re-render every minute so the relative "2m/1h" times stay fresh and aged-out
		// entries drop off on their own.
		if (this._historyRefreshTimer) clearInterval(this._historyRefreshTimer);
		this._historyRefreshTimer = setInterval(() => this.renderEventHistory(), 60000);
	},

	seedHistory(stored) {
		this.eventHistory = (Array.isArray(stored) ? stored : []).map((e) => ({
			deviceId: e.deviceId,
			name: this._nameForDevice(e.deviceId) || (e.deviceId ? e.deviceId.slice(0, 10) + "…" : "Camera"),
			kind: e.kind,
			label: e.label,
			at: e.at
		}));
		this.renderEventHistory();
	},

	// Re-derive each history row's camera label from the current camera names.
	// Called after device names are (re)fetched so the feed matches the tiles.
	relabelHistory() {
		for (const e of this.eventHistory) {
			const name = this._nameForDevice(e.deviceId);
			if (name) e.name = name;
		}
	},

	_nameForDevice(deviceId) {
		const id = this.cameraOrder.find((i) => this.cameras[i].config.nestDeviceId === deviceId);
		return id ? this.cameras[id].name : null;
	},

	// Pure: the entries to display (age-filtered, newest first, capped). No DOM.
	_visibleHistory(now) {
		const maxAge = this.config.historyMaxAgeMs || 0;
		const maxN = this.config.historyMaxEntries || 20;
		let items = this.eventHistory.slice();
		if (maxAge > 0) items = items.filter((e) => now - e.at <= maxAge);
		items.sort((a, b) => b.at - a.at);
		return items.slice(0, maxN);
	},

	_historyContainer() {
		const pos = (this.config.historyPosition || "top_left").replace(/_/g, " ");
		const region = document.getElementsByClassName(`region ${pos}`)[0];
		if (!region) return null;
		return region.getElementsByClassName("container")[0] || null;
	},

	_fmtHistTime(ms) {
		const d = new Date(ms);
		const p = (n) => String(n).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())}`;
	},

	renderEventHistory() {
		if (!this.config.showEventHistory) return;
		const container = this._historyContainer();
		if (!container) return;

		let el = this._historyEl;
		if (!el || !el.isConnected) {
			el = document.createElement("div");
			el.id = `${this.identifier}-history`;
			// The "module" class matters: MagicMirror's updateWrapperStates() hides any
			// region container that holds no .module element, so without it an injected
			// panel in an otherwise-empty region (e.g. middle_center) gets display:none.
			// For a vertically-centred region, lift the card so it clears whatever sits
			// in the lower third (e.g. the compliments module).
			const mid = /middle|center/.test(this.config.historyPosition || "");
			el.className = "module rtw-history" + (mid ? " rtw-history-mid" : "");
			this._historyEl = el;
		}
		if (el.parentNode !== container) container.appendChild(el);
		// Font size is config-driven so the panel can be compact in a corner or
		// large in the centre.
		el.style.fontSize = this.config.historyFontSize || "";

		el.innerHTML = "";
		const title = document.createElement("div");
		title.className = "rtw-history-title";
		title.textContent = this.config.historyTitle || "Event History";
		el.appendChild(title);

		const items = this._visibleHistory(Date.now());
		if (!items.length) {
			const empty = document.createElement("div");
			empty.className = "rtw-history-empty";
			empty.textContent = "No events yet";
			el.appendChild(empty);
			return;
		}
		// One shared grid so every row's columns line up: dot · camera · type · when.
		const now = Date.now();
		const rows = document.createElement("div");
		rows.className = "rtw-history-rows";
		for (const e of items) {
			const kindClass = e.kind === "doorbell" ? "rtw-h-doorbell" : "rtw-h-motion";
			const fresh = now - e.at < 90000 ? " rtw-h-fresh" : "";
			// Each event is its own row wrapper so it can carry a divider and a
			// fresh-event highlight while the cells stay column-aligned.
			const row = document.createElement("div");
			row.className = `rtw-h-row ${kindClass}${fresh}`;
			const dot = document.createElement("span");
			dot.className = `rtw-h-dot ${kindClass}${fresh}`;
			const c = document.createElement("span");
			c.className = "rtw-h-cam";
			c.textContent = e.name;
			const k = document.createElement("span");
			k.className = `rtw-h-type ${kindClass}`;
			k.textContent = e.label || (e.kind === "doorbell" ? "DOORBELL" : "MOTION");
			const ago = document.createElement("span");
			ago.className = "rtw-h-ago";
			ago.textContent = this._agoText(e.at, now);
			row.append(dot, c, k, ago);
			rows.appendChild(row);
		}
		el.appendChild(rows);
	},

	// Compact relative time for the feed: "now", "3m", "2h", "1d".
	_agoText(ms, now) {
		const s = Math.max(0, Math.floor((now - ms) / 1000));
		if (s < 45) return "now";
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		return `${Math.floor(h / 24)}d`;
	},

	// ---------------------------------------------------------------------------
	// DOM / layout
	// ---------------------------------------------------------------------------

	_makeDarkScreen(message) {
		const el = document.createElement("div");
		el.classList.add("rtw-dark-screen");
		el.textContent = message;
		return el;
	},

	_stateTile(cameraId, contentEl) {
		const wrapper = document.createElement("div");
		wrapper.classList.add("rtw-wrapper");
		wrapper.appendChild(contentEl);
		const label = document.createElement("div");
		label.classList.add("rtw-label");
		label.textContent = this.cameras[cameraId].name;
		this.cameras[cameraId].labelEl = label;
		wrapper.appendChild(label);
		return wrapper;
	},

	getDom() {
		const root = document.createElement("div");
		root.classList.add("rtw-root", `rtw-layout-${this.config.layout || "hero"}`);

		// Account-level auth gate applies to every camera
		if (this.needsAuth) {
			const authDiv = document.createElement("div");
			authDiv.classList.add("rtw-error", "small");
			authDiv.innerHTML = "Nest camera requires authentication. ";
			const link = document.createElement("a");
			link.href = this.authUrl || "#";
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.textContent = "Click to authorize";
			authDiv.appendChild(link);
			authDiv.appendChild(document.createTextNode(", then add the code from the redirect URL to nestCode in config and restart."));
			root.appendChild(authDiv);
			return root;
		}

		if (!this.cameraOrder.length) {
			root.classList.add("rtw-error", "small");
			root.textContent = "No cameras configured.";
			return root;
		}

		root.style.setProperty("--hero-width", this.config.heroWidth || this.config.width);
		root.style.setProperty("--thumb-width", this.config.thumbWidth);

		switch (this.config.layout) {
			case "grid":
				this.renderGrid(root);
				break;
			case "carousel":
				this.renderCarousel(root);
				break;
			case "focus":
				this.renderFocus(root);
				break;
			case "hero":
			default:
				this.renderHero(root);
		}
		return root;
	},

	renderHero(root) {
		const heroId = this.cameras[this.heroId] ? this.heroId : this.cameraOrder[0];

		const heroWrap = document.createElement("div");
		heroWrap.classList.add("rtw-hero");
		heroWrap.appendChild(this.renderCameraTile(heroId, true));
		root.appendChild(heroWrap);

		const others = this.cameraOrder.filter((id) => id !== heroId);
		if (others.length) {
			const thumbs = document.createElement("div");
			thumbs.classList.add("rtw-thumbs");
			for (const id of others) {
				thumbs.appendChild(this.renderCameraTile(id, false));
			}
			root.appendChild(thumbs);
		}
	},

	// Phase 3 stubs — CSS scaffolding exists; render branches land later.
	renderGrid(root) {
		Log.warn(`${this.name} layout 'grid' not implemented yet; falling back to hero`);
		this.renderHero(root);
	},
	renderCarousel(root) {
		Log.warn(`${this.name} layout 'carousel' not implemented yet; falling back to hero`);
		this.renderHero(root);
	},
	renderFocus(root) {
		Log.warn(`${this.name} layout 'focus' not implemented yet; falling back to hero`);
		this.renderHero(root);
	},

	renderCameraTile(cameraId, isHero) {
		const cam = this.cameras[cameraId];
		if (cam.tokenExpired) return this._stateTile(cameraId, this._makeDarkScreen("Expired Token"));
		if (cam.noSignal) return this._stateTile(cameraId, this._makeDarkScreen("No Signal"));

		if (cam.stream) {
			// Reuse existing wrapper to avoid restarting the stream / size flicker.
			// Moving the cached <video> between the hero and thumbnail containers keeps
			// it playing; only the equalizer needs to follow the hero.
			if (cam.wrapper && cam.video && cam.video.srcObject === cam.stream) {
				// Re-parenting a <video> during re-render detaches it from the document,
				// which pauses it in Chromium and freezes the tile on a stale frame.
				// Resume it whenever we hand back the cached tile.
				if (cam.video.paused) cam.video.play().catch(() => {});
				this._syncEqualizer(cameraId, isHero);
				this._syncEventFlag(cameraId);
				this._syncModeBadge(cameraId, isHero);
				return cam.wrapper;
			}

			this.cleanupAudio(cameraId);

			cam.video = document.createElement("video");
			cam.video.classList.add("rtw-video");
			cam.video.autoplay = true;
			cam.video.controls = false;
			cam.video.volume = 1;
			cam.video.muted = true;
			cam.video.playsInline = true;
			cam.video.srcObject = cam.stream;
			cam.video.play().catch((err) => Log.warn(`[${this.name}] Video playback failed: ${err.message}`));

			const recover = () => {
				cam.video.srcObject = cam.stream;
				cam.video.play().catch(() => {});
			};
			cam.video.onstalled = recover;
			cam.video.onerror = recover;

			cam.canvas = null;
			cam.wrapper = document.createElement("div");
			cam.wrapper.classList.add("rtw-wrapper");
			cam.wrapper.appendChild(cam.video);

			const label = document.createElement("div");
			label.classList.add("rtw-label");
			label.textContent = cam.name;
			cam.labelEl = label;
			cam.wrapper.appendChild(label);

			this._syncEqualizer(cameraId, isHero);
			this._syncEventFlag(cameraId);
			this._syncModeBadge(cameraId, isHero);
			return cam.wrapper;
		}

		const connecting = document.createElement("div");
		connecting.classList.add("rtw-error", "small");
		connecting.innerHTML = "Connecting to Nest camera...";
		return this._stateTile(cameraId, connecting);
	},

	// Adds the equalizer canvas to the hero tile and removes it from demoted tiles,
	// without recreating the <video> element.
	_syncEqualizer(cameraId, isHero) {
		const cam = this.cameras[cameraId];
		if (!cam || !cam.wrapper) return;
		if (isHero) {
			if (!cam.canvas) {
				const canvas = document.createElement("canvas");
				canvas.classList.add("rtw-equalizer");
				canvas.width = 18;
				canvas.height = 200;
				cam.canvas = canvas;
				cam.wrapper.appendChild(canvas);
				// Defer so the canvas is connected to the DOM before we start drawing
				setTimeout(() => this.startAudioVisualizer(cameraId), 0);
			}
		} else if (cam.canvas) {
			this.cleanupAudio(cameraId);
			if (cam.canvas.parentNode) cam.canvas.parentNode.removeChild(cam.canvas);
			cam.canvas = null;
		}
	},

	// ---------------------------------------------------------------------------
	// Notifications (MagicMirror inter-module)
	// ---------------------------------------------------------------------------

	async notificationReceived(notification, payload, sender) {
		switch (notification) {
			case "USER_PRESENCE":
				// From MMM-PIR-sensor / similar — suspend the whole module when nobody's around
				if (payload) {
					this.suspendedForUserPresence = false;
					if (this.suspended && !this.hidden) {
						await this.resume();
					}
				} else {
					this.suspendedForUserPresence = true;
					if (!this.suspended) {
						this.suspend();
					}
				}
				break;
			case "NEST_CAM_SET_HERO":
				this.applyControl("set", payload);
				break;
			case "NEST_CAM_NEXT":
				this.applyControl("next");
				break;
			case "NEST_CAM_PREV":
				this.applyControl("prev");
				break;
			case "NEST_CAM_PAUSE_CYCLE":
				this.applyControl("pause");
				break;
			case "NEST_CAM_RESUME_CYCLE":
				this.applyControl("resume");
				break;
		}
	},

	// ---------------------------------------------------------------------------
	// Socket notifications (frontend <-> node_helper)
	// ---------------------------------------------------------------------------

	async socketNotificationReceived(notification, payload) {
		// Web control page relays commands through node_helper as CONTROL_CMD.
		// It's broadcast to every instance of this module, so ignore commands
		// addressed to a different instance.
		if (notification === "CONTROL_CMD") {
			if (payload && payload.identifier === this.identifier) {
				let target = payload.target;
				if (typeof target === "string" && /^\d+$/.test(target)) target = parseInt(target, 10);
				// Setup helper: simulate a motion/doorbell event so you can verify the
				// flag renders without waiting for Nest (which throttles real events).
				if (payload.action === "test-motion" || payload.action === "test-doorbell") {
					const cid = this.resolveCameraId(target != null ? target : this.heroId);
					if (cid) {
						const doorbell = payload.action === "test-doorbell";
						this.handleMotionEvent(cid, doorbell ? "doorbell" : "motion", doorbell ? "DOORBELL" : "TEST", { record: false });
					}
				} else {
					this.applyControl(payload.action, target);
				}
			}
			return;
		}

		// Nest motion/doorbell event (broadcast to all instances); handle it if the
		// event's device belongs to one of this instance's cameras.
		if (notification === "NEST_EVENT") {
			if (payload && payload.deviceId) {
				const cameraId = this.cameraOrder.find(
					(id) => this.cameras[id].config.nestDeviceId === payload.deviceId
				);
				if (cameraId) this.handleMotionEvent(cameraId, payload.kind, payload.label, { at: payload.at });
			}
			return;
		}

		// Per-camera notifications carry a cameraId suffix (`${identifier}__${index}`).
		// Account-level notifications carry the bare module identifier suffix.
		for (const cameraId of this.cameraOrder) {
			if (notification.endsWith(`_${cameraId}`)) {
				const verb = notification.slice(0, notification.length - cameraId.length - 1);
				await this.handleCameraNotification(verb, cameraId, payload);
				return;
			}
		}
		if (notification.endsWith(`_${this.identifier}`)) {
			const verb = notification.slice(0, notification.length - this.identifier.length - 1);
			await this.handleAccountNotification(verb, payload);
		}
	},

	async handleAccountNotification(verb, payload) {
		switch (verb) {
			case "TOKEN":
				this.token = payload.access_token;
				this.refreshToken = payload.refresh_token || this.refreshToken;
				this.tokenRequested = false;
				this.needsAuth = false;
				if (this.token) {
					await this.initAllCameras();
					this.requestDeviceNames();
				}
				this.updateDom();
				break;
			case "NEED_AUTH":
				this.tokenRequested = false;
				this.needsAuth = true;
				this.authUrl = payload.authUrl;
				this.updateDom();
				break;
			case "HISTORY":
				// Persisted event history from node_helper (array of {deviceId, kind, label, at}).
				this.seedHistory(payload);
				break;
			case "DEVICE_NAMES":
				// { deviceId: name } pulled from the Google Home app via the SDM API.
				this.applyDeviceNames(payload);
				break;
		}
	},

	// Ask node_helper for each camera's current name in the Google Home app. It
	// replies DEVICE_NAMES_<identifier>. Runs once per token acquisition.
	requestDeviceNames() {
		if (!this.config.autoFetchNames || !this.token) return;
		const first = this.cameras[this.cameraOrder[0]];
		if (!first) return;
		this.sendSocketNotification("GET_DEVICE_NAMES", {
			token: this.token,
			nestProjectId: first.config.nestProjectId,
			identifier: this.identifier
		});
	},

	// Override each camera's display name with the fetched Google Home name. A
	// device missing from the map (no custom name / no room) keeps its config name.
	applyDeviceNames(names) {
		if (!names || typeof names !== "object") return;
		let changed = false;
		for (const id of this.cameraOrder) {
			const cam = this.cameras[id];
			const fetched = names[cam.config.nestDeviceId];
			if (fetched && fetched !== cam.name) {
				cam.name = fetched;
				// Live video tiles are cached across updateDom (to avoid tearing down the
				// WebRTC stream), so patch the existing label element in place.
				if (cam.labelEl) cam.labelEl.textContent = fetched;
				changed = true;
			}
		}
		if (changed) {
			this.relabelHistory();
			this.renderEventHistory();
			this.updateDom();
			this.pushControlState();
		}
	},

	async handleCameraNotification(verb, cameraId, payload) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		switch (verb) {
			case "ANSWER":
				Log.log(`${this.name} received answer for ${cam.name}`);
				if (!cam.pc) {
					Log.warn(`${this.name} received answer but peer connection was closed (${cam.name})`);
					break;
				}
				try {
					// Patch SDP: Electron 41+ is strict about direction compatibility.
					// Nest may return sendrecv in the answer; replace with sendonly
					// to match our recvonly offer.
					const patchedSdp = payload.replace(/\ba=sendrecv\b/g, "a=sendonly");
					await cam.pc.setRemoteDescription(
						new RTCSessionDescription({type: "answer", sdp: patchedSdp})
					);
					this.updateDom();
					this.pushControlState();
				} catch (e) {
					Log.warn(`${this.name} setRemoteDescription failed (${cam.name}):`, e);
				}
				break;
			case "TOKEN_EXPIRED":
				cam.tokenExpired = true;
				this.cleanupConnection(cameraId);
				if (this.heroId === cameraId) this.ensureViewableHero();
				this.updateDom();
				this.pushControlState();
				break;
			case "STREAM_UNAVAILABLE":
				// Camera is offline / not currently streamable (e.g. 400 FAILED_PRECONDITION).
				// Show "No Signal" and let the 30s retry loop recover it when it comes back.
				Log.log(`${this.name} ${cam.name} not available for streaming; will retry`);
				this.cleanupConnection(cameraId);
				cam.noSignal = true;
				this.startNoSignalRetry(cameraId);
				if (this.heroId === cameraId) this.ensureViewableHero();
				this.updateDom();
				this.pushControlState();
				break;
			case "RECONNECT":
				Log.log(`${this.name} session invalid; reconnecting ${cam.name}`);
				this.cleanupConnection(cameraId);
				await this.initializeRTCPeerConnection(cameraId);
				this.updateDom();
				break;
			case "REFRESH":
				this.token = payload.access_token;
				if (payload.refresh_token) {
					this.refreshToken = payload.refresh_token;
				}
				if (payload.retry) {
					// Token was refreshed after START_STREAM failed; retry full connection
					this.cleanupConnection(cameraId);
					await this.initializeRTCPeerConnection(cameraId);
					this.updateDom();
				} else {
					this.sendExtend(cameraId);
				}
				break;
		}
	},

	requestToken() {
		if (this.tokenRequested || this.token) return;
		this.tokenRequested = true;
		const first = this.cameras[this.cameraOrder[0]];
		this.sendSocketNotification("GET_TOKEN", {
			nestClientId: first.config.nestClientId,
			nestClientSecret: first.config.nestClientSecret,
			nestCode: first.config.nestCode,
			nestProjectId: first.config.nestProjectId,
			identifier: this.identifier
		});
	},

	sendExtend(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		this.sendSocketNotification("EXTEND_STREAM", {
			token: this.token,
			identifier: cameraId,
			nestProjectId: cam.config.nestProjectId,
			nestDeviceId: cam.config.nestDeviceId,
			nestClientId: cam.config.nestClientId,
			nestClientSecret: cam.config.nestClientSecret,
			refreshToken: this.refreshToken
		});
	},

	// ---------------------------------------------------------------------------
	// WebRTC (per camera)
	// ---------------------------------------------------------------------------

	async initializeRTCPeerConnection(cameraId) {
		const cam = this.cameras[cameraId];
		if (!cam) return;
		if (this.suspended) return;
		if (cam.tokenExpired) return;
		if (cam.pc) return;                 // already connected/connecting
		if (!this.token) {
			this.requestToken();            // shared account token, fetched once
			return;
		}

		Log.log(`${this.name} initializing connection for ${cam.name} (${cameraId})`);
		cam.deliberateClose = false;
		cam.lastFrames = 0;
		cam.stallCount = 0;

		cam.stream = new MediaStream();
		cam.pc = new RTCPeerConnection({
			iceServers: [
				{
					urls: ["stun:stun.l.google.com:19302"]
				}
			],
			sdpSemantics: "unified-plan"
		});

		cam.pc.onconnectionstatechange = () => {
			if (this.suspended) return;
			const state = cam.pc ? cam.pc.connectionState : "closed";
			const delay = cam.config.reconnectDelay ?? 3000;
			if (state === "failed") {
				Log.log(`${this.name} connection failed (${cam.name}), reconnecting in ${delay}ms`);
				this.cleanupConnection(cameraId);
				cam.reconnectTimeout = setTimeout(() => {
					cam.reconnectTimeout = null;
					this.initializeRTCPeerConnection(cameraId);
				}, delay);
			} else if (state === "disconnected") {
				// "disconnected" can be transient — give it 15s to self-recover before forcing reconnect
				if (!cam.disconnectTimeout) {
					Log.log(`${this.name} connection disconnected (${cam.name}), will force reconnect in 15s if not recovered`);
					cam.disconnectTimeout = setTimeout(() => {
						cam.disconnectTimeout = null;
						if (cam.pc && cam.pc.connectionState === "disconnected" && !this.suspended) {
							Log.log(`${this.name} connection still disconnected (${cam.name}), forcing reconnect`);
							this.cleanupConnection(cameraId);
							this.initializeRTCPeerConnection(cameraId);
						}
					}, 15000);
				}
			} else if (state === "connected") {
				// Self-recovered from disconnected — cancel the pending forced reconnect
				if (cam.disconnectTimeout) {
					clearTimeout(cam.disconnectTimeout);
					cam.disconnectTimeout = null;
				}
			}
		};

		cam.pc.ontrack = (event) => {
			cam.stream.addTrack(event.track);
			if (event.track.kind === "video") {
				event.track.onmute = () => {
					cam.noSignal = true;
					this.startNoSignalRetry(cameraId);
					if (this.heroId === cameraId) this.ensureViewableHero();
					this.updateDom();
					this.pushControlState();
				};
				event.track.onunmute = () => {
					cam.noSignal = false;
					this.stopNoSignalRetry(cameraId);
					this.ensureViewableHero();
					this.updateDom();
					this.pushControlState();
				};
				cam.noSignal = event.track.muted;
				if (cam.noSignal) this.startNoSignalRetry(cameraId);
				else this.ensureViewableHero();
				this.updateDom();
				this.pushControlState();
			} else if (event.track.kind === "audio") {
				// Audio may arrive after the DOM is already built; start visualizer if this is the hero
				setTimeout(() => this.startAudioVisualizer(cameraId), 0);
			}
		};

		const pingChannel = cam.pc.createDataChannel("ping");
		pingChannel.onopen = () => {
			const interval = cam.config.extendInterval ?? 240000;
			cam.pingIntervalId = setInterval(() => {
				try {
					this.sendExtend(cameraId);
				} catch (e) {
					Log.warn(`${this.name} EXTEND_STREAM notification failed (${cam.name}):`, e);
				}
			}, interval);
		};
		pingChannel.onclose = () => {
			if (cam.pingIntervalId) {
				clearInterval(cam.pingIntervalId);
				cam.pingIntervalId = null;
			}
			// Don't reconnect if we closed the connection on purpose — the code path
			// that tore it down (suspend, no-signal retry, STREAM_UNAVAILABLE, …)
			// owns the decision to reconnect.
			if (this.suspended || cam.deliberateClose) return;
			const delay = cam.config.reconnectDelay ?? 3000;
			Log.log(`${this.name} ping channel closed (${cam.name}); reconnecting in ${delay}ms`);
			this.cleanupConnection(cameraId);
			cam.reconnectTimeout = setTimeout(() => {
				cam.reconnectTimeout = null;
				this.initializeRTCPeerConnection(cameraId);
			}, delay);
		};

		cam.pc.addTransceiver("audio", {direction: "recvonly"});
		cam.pc.addTransceiver("video", {direction: "recvonly"});
		cam.pc.onnegotiationneeded = async () => {
			if (!cam.pc) return;
			const offer = await cam.pc.createOffer();
			await cam.pc.setLocalDescription(offer);

			this.sendSocketNotification("START_STREAM", {
				token: this.token,
				sdp: cam.pc.localDescription.sdp,
				identifier: cameraId,
				nestProjectId: cam.config.nestProjectId,
				nestDeviceId: cam.config.nestDeviceId,
				nestClientId: cam.config.nestClientId,
				nestClientSecret: cam.config.nestClientSecret,
				refreshToken: this.refreshToken
			});
		};
	}
});
