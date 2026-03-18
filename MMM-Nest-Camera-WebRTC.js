Module.register("MMM-Nest-Camera-WebRTC", {
	video: null,
	pc: null,
	stream: null,
	reconnectTimeout: null,

	token: null,
	refreshToken: null,
	needsAuth: false,
	authUrl: null,

	suspended: false,
	suspendedForUserPresence: false,

	defaults: {
		width: "33%",
		reconnectDelay: 3000,
		extendInterval: 240000,
		nestClientId: '',
		nestClientSecret: '',
		nestCode: '',
		nestProjectId: '',
		nestDeviceId: ''
	},

	async start() {
		if (this.data.hiddenOnStartup) {
			// Don't connect if module is going to be hidden
			this.suspended = true;
			return;
		}
		await this.initializeRTCPeerConnection();
	},

	async suspend() {
		this.suspended = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.cleanupConnection();
	},

	cleanupConnection() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.stream) {
			this.stream.getTracks().forEach((track) => track.stop());
			this.stream = null;
		}
		if (this.pc) {
			this.pc.close();
			this.pc = null;
		}
		if (this.video) {
			this.video.srcObject = null;
			this.video = null;
		}
	},

	async resume() {
		this.suspended = false;
		await this.initializeRTCPeerConnection();
	},

	stop() {
		this.cleanupConnection();
	},

	getStyles() {
		return [`${this.name}.css`];
	},

	getDom() {
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
			return authDiv;
		}
		if (this.stream) {
			// Reuse existing video element to avoid size flicker from recreating
			if (this.video && this.video.srcObject === this.stream) {
				return this.video;
			}
			this.video = document.createElement("video");
			this.video.classList.add("rtw-video");
			this.video.autoplay = true;
			this.video.controls = false;
			this.video.volume = 1;
			this.video.muted = true;
			this.video.playsInline = true;
			// Explicit dimensions prevent collapse before stream metadata loads and prevent
			// resizing when the stream changes resolution (adaptive bitrate).
			if (this.config.width) {
				this.video.style.width = this.config.width;
				// If width is in pixels, lock height too so both dimensions are fixed and
				// the browser cannot reflow the element when video intrinsic size changes.
				const pxMatch = String(this.config.width).match(/^(\d+(?:\.\d+)?)px$/i);
				if (pxMatch) {
					this.video.style.height = `${Math.round(parseFloat(pxMatch[1]) * 9 / 16)}px`;
				}
			}
			this.video.style.aspectRatio = "16 / 9";
			this.video.style.minWidth = "320px";
			this.video.style.minHeight = "180px";
			this.video.srcObject = this.stream;
			this.video.play().catch(() => {});

			const recover = () => {
				this.video.srcObject = this.stream;
				this.video.play();
			};
			this.video.onstalled = recover;
			this.video.onerror = recover;

			return this.video;
		}

		const error = document.createElement("div");
		error.classList.add("rtw-error", "small");
		error.innerHTML = "Connecting to Nest camera...";
		return error;
	},

	async notificationReceived(notification, payload, sender) {
		// Handle USER_PRESENCE events from the MMM-PIR-sensor/similar modules
		if (notification === "USER_PRESENCE") {
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
		}
	},

	async socketNotificationReceived(notification, payload) {
		switch (notification) {
			case `ANSWER_${this.identifier}`:
				Log.log(`${this.name} received answer for ${this.identifier}`);
				if (!this.pc) {
					Log.warn(`${this.name} received answer but peer connection was closed`);
					break;
				}
				try {
					await this.pc.setRemoteDescription(
						new RTCSessionDescription({type: "answer", sdp: payload})
					);
					this.updateDom();
				} catch (e) {
					Log.warn(`${this.name} setRemoteDescription failed:`, e);
				}
				break;
			case `TOKEN_${this.identifier}`:
				this.token = payload.access_token;
				this.refreshToken = payload.refresh_token || this.refreshToken;
				this.needsAuth = false;
				if (payload.error !== "invalid_grant") {
					await this.initializeRTCPeerConnection();
				}
				this.updateDom();
				break;
			case `NEED_AUTH_${this.identifier}`:
				this.needsAuth = true;
				this.authUrl = payload.authUrl;
				this.updateDom();
				break;
			case `RECONNECT_${this.identifier}`:
				Log.log(`${this.name} session invalid; reconnecting`);
				this.cleanupConnection();
				await this.initializeRTCPeerConnection();
				this.updateDom();
				break;
			case `REFRESH_${this.identifier}`:
				this.token = payload.access_token;
				if (payload.refresh_token) {
					this.refreshToken = payload.refresh_token;
				}
				if (payload.retry) {
					// Token was refreshed after START_STREAM failed; retry full connection
					this.cleanupConnection();
					await this.initializeRTCPeerConnection();
				} else {
					this.sendSocketNotification("EXTEND_STREAM", {
						token: this.token,
						identifier: this.identifier,
						nestProjectId: this.config.nestProjectId,
						nestDeviceId: this.config.nestDeviceId,
						nestClientId: this.config.nestClientId,
						nestClientSecret: this.config.nestClientSecret,
						refreshToken: this.refreshToken
					});
				}
				// Only update DOM when retrying (stream was cleared); skip for extend to avoid size flicker
				if (payload.retry) this.updateDom();
				break;
		}
	},

	async initializeRTCPeerConnection() {
		if (this.suspended) return;
		if (!this.token) {
			this.sendSocketNotification("GET_TOKEN", {
				nestClientId: this.config.nestClientId,
				nestClientSecret: this.config.nestClientSecret,
				nestCode: this.config.nestCode,
				identifier: this.identifier
			});
			return;
		}

		Log.log(`${this.name} initializing connection for ${this.identifier}`);

		this.stream = new MediaStream();
		this.pc = new RTCPeerConnection({
			iceServers: [
				{
					urls: ["stun:stun.l.google.com:19302"]
				}
			],
			sdpSemantics: "unified-plan"
		});

		this.pc.onconnectionstatechange = () => {
			if (this.pc.connectionState === "failed" && !this.suspended) {
				const delay = this.config.reconnectDelay ?? 3000;
				Log.log(`${this.name} connection in failed state, reconnecting in ${delay}ms`);
				this.cleanupConnection();
				this.reconnectTimeout = setTimeout(() => {
					this.reconnectTimeout = null;
					this.initializeRTCPeerConnection();
				}, delay);
			}
		};

		this.pc.ontrack = (event) => {
			this.stream.addTrack(event.track);
			if (event.track.kind === "video") {
				this.updateDom();
			}
		};

		const pingChannel = this.pc.createDataChannel("ping");
		let intervalId;
		pingChannel.onopen = () => {
			const interval = this.config.extendInterval ?? 240000;
			intervalId = setInterval(() => {
				try {
					this.sendSocketNotification("EXTEND_STREAM", {
						token: this.token,
						identifier: this.identifier,
						nestProjectId: this.config.nestProjectId,
						nestDeviceId: this.config.nestDeviceId,
						nestClientId: this.config.nestClientId,
						nestClientSecret: this.config.nestClientSecret,
						refreshToken: this.refreshToken,
					});
				} catch (e) {
					Log.warn(`${this.name} EXTEND_STREAM notification failed:`, e);
				}
			}, interval);
		};
		pingChannel.onclose = () => {
			clearInterval(intervalId);
			if (this.suspended) return;
			const delay = this.config.reconnectDelay ?? 3000;
			Log.log(`${this.name} ping channel closed; reconnecting in ${delay}ms`);
			this.cleanupConnection();
			this.reconnectTimeout = setTimeout(() => {
				this.reconnectTimeout = null;
				this.initializeRTCPeerConnection();
			}, delay);
		};

		this.pc.addTransceiver("audio", {direction: "recvonly"});
		this.pc.addTransceiver("video", {direction: "recvonly"});
		this.pc.onnegotiationneeded = async () => {
			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);

			this.sendSocketNotification("START_STREAM", {
				token: this.token,
				sdp: this.pc.localDescription.sdp,
				identifier: this.identifier,
				nestProjectId: this.config.nestProjectId,
				nestDeviceId: this.config.nestDeviceId,
				nestClientId: this.config.nestClientId,
				nestClientSecret: this.config.nestClientSecret,
				refreshToken: this.refreshToken
			});
		};
	}
});
