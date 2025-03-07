Module.register("MMM-Nest-Camera-WebRTC", {
	video: null,
	pc: null,
	stream: null,
	connectTimeout: null,

	suspended: false,
	suspendedForUserPresence: false,

	defaults: {
		width: "33%",
		token: "",
		url: ""
	},

	first: true,

	async start() {
		if (this.data.hiddenOnStartup) {
			// Don't connect if module is going to be hidden
			this.suspended = true;
			return;
		}
		await this.initializeRTCPeerConnection();
	},

	suspend() {
		this.suspended = true;
		if (this.stream) {
			this.stream.getTracks().forEach((track) => {
				track.stop();
			});
			this.pc.close();
			this.pc = null;
			this.video.srcObject = null;
			this.stream = null;
		}
	},

	async resume() {
		this.suspended = false;
		await this.initializeRTCPeerConnection();
		this.updateDom();
	},

	getStyles() {
		return [`${this.name}.css`];
	},

	getDom() {
		if (this.stream) {
			this.video = document.createElement("video");
			this.video.classList.add("rtw-video");
			this.video.autoplay = true;
			this.video.controls = false;
			this.video.volume = 1;
			this.video.muted = true;
			this.video.style.maxWidth = this.config.width;
			this.video.playsInline = true;
			this.video.srcObject = this.stream;

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
		error.innerHTML = "No data from stream";
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
		if (notification === `ANSWER_${this.identifier}`) {
			Log.log(`${this.name} received answer for ${this.identifier}`);
			try {
				await this.pc.setRemoteDescription(
					new RTCSessionDescription({type: "answer", sdp: payload})
				);
			} catch (e) {
				console.warn(e);
			}
		}
	},

	async initializeRTCPeerConnection() {
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
			if (this.pc.connectionState === "failed") {
				console.log(`${this.name} connection in failed state, restarting`);
				this.pc.close();
				this.video.srcObject = null;
				this.initializeRTCPeerConnection();
			}
		};

		this.pc.ontrack = (event) => {
			this.stream.addTrack(event.track);
		};

		const pingChannel = this.pc.createDataChannel("ping");
		let intervalId;
		pingChannel.onopen = () => {
			intervalId = setInterval(() => {
				try {
					this.sendSocketNotification("EXTEND_STREAM", {
						token: this.config.token,
						identifier: this.identifier,
						nestProjectId: this.config.nestProjectId,
						nestDeviceId: this.config.nestDeviceId
					});
				} catch (e) {
					console.warn(e);
				}
			}, 300000);
		};
		pingChannel.onclose = () => {
			clearInterval(intervalId);
			if (this.suspended) {
				return;
			} // Closed due to module being hidden
			console.log(`${this.name} ping channel closed; restarting...`);
			this.initializeRTCPeerConnection();
		};

		this.pc.addTransceiver("audio", {direction: "recvonly"});
		this.pc.addTransceiver("video", {direction: "recvonly"});
		this.pc.onnegotiationneeded = async () => {
			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);

			this.sendSocketNotification("START_STREAM", {
				token: this.config.token,
				sdp: this.pc.localDescription.sdp,
				identifier: this.identifier,
				nestProjectId: this.config.nestProjectId,
				nestDeviceId: this.config.nestDeviceId
			});
		};
	}
});
