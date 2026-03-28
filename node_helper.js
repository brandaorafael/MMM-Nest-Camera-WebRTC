const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const Log = require("logger");

/** Per-instance media session IDs (keyed by identifier) for multi-camera support */
const mediaSessionIds = {};

const getTokensPath = () => path.join(__dirname, "tokens.json");

function loadTokens() {
	try {
		const data = fs.readFileSync(getTokensPath(), "utf8");
		return JSON.parse(data);
	} catch {
		return null;
	}
}

function saveTokens(tokens) {
	fs.writeFileSync(getTokensPath(), JSON.stringify(tokens, null, 2), "utf8");
}

module.exports = NodeHelper.create({
	start() {
		Log.info(`Starting node_helper for module [${this.name}]`);
	},

	async exchangeCodeForTokens(payload) {
		Log.info(`Exchanging Nest authorization code for tokens`);
		try {
			const response = await fetch(
				`https://www.googleapis.com/oauth2/v4/token?client_id=${payload.nestClientId}&client_secret=${payload.nestClientSecret}&code=${payload.nestCode}&grant_type=authorization_code&redirect_uri=https://www.google.com`,
				{
					headers: { "Content-Type": "application/json" },
					method: "POST"
				}
			);
			return response.json();
		} catch (err) {
			Log.error(`Code exchange request failed: ${err.message}`);
			return { error: err.message };
		}
	},

	async refreshAccessToken(payload) {
		const url = `https://www.googleapis.com/oauth2/v4/token?client_id=${payload.nestClientId}&client_secret=${payload.nestClientSecret}&refresh_token=${payload.refreshToken}&grant_type=refresh_token`;
		try {
			const response = await fetch(url, {
				headers: { "Content-Type": "application/json" },
				method: "POST"
			});
			return response.json();
		} catch (err) {
			Log.error(`Token refresh request failed: ${err.message}`);
			return { error: err.message };
		}
	},

	async getNestToken(payload) {
		// 1. Try to load saved tokens and refresh if we have refresh_token
		let tokens = loadTokens();
		if (tokens?.refresh_token) {
			const refreshed = await this.refreshAccessToken({
				nestClientId: payload.nestClientId,
				nestClientSecret: payload.nestClientSecret,
				refreshToken: tokens.refresh_token
			});
			if (refreshed.access_token) {
				const newTokens = { ...tokens, access_token: refreshed.access_token };
				if (refreshed.refresh_token) newTokens.refresh_token = refreshed.refresh_token;
				saveTokens(newTokens);
				this.sendSocketNotification(`TOKEN_${payload.identifier}`, newTokens);
				return;
			}
		}

		// 2. Try to exchange nestCode if provided (prioritize fresh auth over stale saved token)
		if (payload.nestCode) {
			const resBody = await this.exchangeCodeForTokens(payload);
			if (resBody.access_token) {
				const newTokens = {
					access_token: resBody.access_token,
					refresh_token: resBody.refresh_token || tokens?.refresh_token
				};
				saveTokens(newTokens);
				this.sendSocketNotification(`TOKEN_${payload.identifier}`, newTokens);
				return;
			}
			Log.error(`Code exchange failed: ${JSON.stringify(resBody)}`);
		}

		// 3. Use saved access_token if we have one (e.g. no refresh_token yet)
		if (tokens?.access_token) {
			this.sendSocketNotification(`TOKEN_${payload.identifier}`, tokens);
			return;
		}

		// 4. No valid tokens and no nestCode (or exchange failed)
		this.sendSocketNotification(`NEED_AUTH_${payload.identifier}`, {
			authUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${payload.nestClientId}&redirect_uri=https://www.google.com&response_type=code&scope=https://www.googleapis.com/auth/sdm.service&access_type=offline&prompt=consent`
		});
	},

	async sendOffer(payload) {
		Log.info(`Getting Nest Media Session for module [${this.name}]`);
		let response;
		try {
			response = await fetch(
			`https://smartdevicemanagement.googleapis.com/v1/enterprises/${payload.nestProjectId}/devices/${payload.nestDeviceId}:executeCommand`,
			{
				headers: {
					Authorization: `Bearer ${payload.token}`,
					"Content-Type": "application/json"
				},
				method: "POST",
				body: JSON.stringify({
					command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
					params: {
						offerSdp: payload.sdp.endsWith("\n") ? payload.sdp : payload.sdp + "\n"
					}
				})
			}
		);
		} catch (err) {
			Log.error(`Nest API request failed: ${err.message}`);
			this.sendSocketNotification(`RECONNECT_${payload.identifier}`);
			return;
		}

		const resBody = await response.json();

		if (resBody.error) {
			Log.error(`Nest API error: ${JSON.stringify(resBody.error)}`);
			if (resBody.error.code === 401) {
				const refreshToken = payload.refreshToken || loadTokens()?.refresh_token;
				if (!refreshToken) {
					Log.error("Token expired and no refresh token available; add nestCode to config and restart");
					return;
				}
				Log.info("Nest token expired; refreshing token");
				const refreshBody = await this.refreshAccessToken({ ...payload, refreshToken });
				if (refreshBody.access_token) {
					const tokens = loadTokens() || {};
					const newTokens = { ...tokens, access_token: refreshBody.access_token };
					if (refreshBody.refresh_token) newTokens.refresh_token = refreshBody.refresh_token;
					saveTokens(newTokens);
					this.sendSocketNotification(`REFRESH_${payload.identifier}`, {
						...refreshBody,
						refresh_token: refreshBody.refresh_token || payload.refreshToken,
						retry: true
					});
				} else {
					Log.error(`Token refresh failed: ${JSON.stringify(refreshBody)}`);
				}
			}
			return;
		}

		if (!resBody.results || !resBody.results.mediaSessionId) {
			Log.error(`Unexpected Nest API response: ${JSON.stringify(resBody)}`);
			return;
		}

		mediaSessionIds[payload.identifier] = resBody.results.mediaSessionId;
		Log.info(`Media session id: ${mediaSessionIds[payload.identifier]} (expires ${resBody.results.expiresAt})`);

		this.sendSocketNotification(`ANSWER_${payload.identifier}`, resBody.results.answerSdp);
	},

	async extendStream(payload) {
		const mediaSessionId = mediaSessionIds[payload.identifier];
		if (!mediaSessionId) {
			Log.warn(`No media session for identifier ${payload.identifier}; cannot extend stream`);
			return;
		}
		Log.info(`Extending Stream for module [${this.name}]`);
		let res;
		try {
			res = await fetch(
			`https://smartdevicemanagement.googleapis.com/v1/enterprises/${payload.nestProjectId}/devices/${payload.nestDeviceId}:executeCommand`,
			{
				headers: {
					Authorization: `Bearer ${payload.token}`,
					"Content-Type": "application/json"
				},
				method: "POST",
				body: JSON.stringify({
					command: "sdm.devices.commands.CameraLiveStream.ExtendWebRtcStream",
					params: { mediaSessionId }
				})
			}
		);
		} catch (err) {
			Log.error(`Extend stream request failed: ${err.message}`);
			delete mediaSessionIds[payload.identifier];
			this.sendSocketNotification(`RECONNECT_${payload.identifier}`);
			return;
		}

		const resBody = await res.json();

		if (resBody.error) {
			if (resBody.error.code === 401) {
				const refreshToken = payload.refreshToken || loadTokens()?.refresh_token;
				if (!refreshToken) {
					Log.error("Token expired and no refresh token available");
					return;
				}
				Log.info("Nest token invalid; Refreshing token");
				const refreshBody = await this.refreshAccessToken({ ...payload, refreshToken });
				if (refreshBody.access_token) {
					const tokens = loadTokens() || {};
					const newTokens = { ...tokens, access_token: refreshBody.access_token };
					if (refreshBody.refresh_token) newTokens.refresh_token = refreshBody.refresh_token;
					saveTokens(newTokens);
					this.sendSocketNotification(`REFRESH_${payload.identifier}`, {
						...refreshBody,
						refresh_token: refreshBody.refresh_token || payload.refreshToken,
						retry: true
					});
				} else {
					Log.error(`Token refresh failed during extend: ${JSON.stringify(refreshBody)}`);
				}
			} else {
				Log.error(`Extend stream failed: ${JSON.stringify(resBody.error)}`);
				// Invalid session (e.g. 400 FAILED_PRECONDITION) - session is dead, trigger full reconnection
				if (resBody.error.code === 400 || resBody.error.status === "FAILED_PRECONDITION") {
					delete mediaSessionIds[payload.identifier];
					Log.info(`Clearing invalid session; notifying frontend to reconnect`);
					this.sendSocketNotification(`RECONNECT_${payload.identifier}`);
				}
			}
		}
	},

	async socketNotificationReceived(notification, payload) {
		switch (notification) {
			case "START_STREAM":
				await this.sendOffer(payload);
				break;
			case "EXTEND_STREAM":
				await this.extendStream(payload);
				break;
			case "GET_TOKEN":
				await this.getNestToken(payload);
				break;
		}
	}
});
