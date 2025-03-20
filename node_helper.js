const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

const Log = require("logger");

let mediaSessionId;
module.exports = NodeHelper.create({
	start() {
		Log.info(`Starting node_helper for module [${this.name}]`);
	},

	async getNestToken(payload) {
		Log.info(`Getting Nest token for module [${this.name}]`);
		const response = await fetch(`https://www.googleapis.com/oauth2/v4/token?client_id=${payload.nestClientId}&client_secret=${payload.nestClientSecret}&code=${payload.nestCode}&grant_type=authorization_code&redirect_uri=https://www.google.com`,
			{
				headers: {
					"Content-Type": "application/json"
				},
				method: "POST"
			});

		const resBody = await response.json();

		Log.info(resBody);

		this.sendSocketNotification(`TOKEN_${payload.identifier}`, resBody);
	},

	async sendOffer(payload) {
		Log.info(`Getting Nest Media Session for module [${this.name}]`);
		const response = await fetch(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${payload.nestProjectId}/devices/${payload.nestDeviceId}:executeCommand`,
			{
				headers: {
					Authorization: `Bearer ${payload.token}`,
					"Content-Type": "application/json"
				},
				method: "POST",
				body: JSON.stringify({
					command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
					params: {
						offerSdp: payload.sdp
					}
				})
			});

		const resBody = await response.json();

		mediaSessionId = resBody.results.mediaSessionId;
		Log.info(`Media session id: ${mediaSessionId} (expires ${resBody.results.expiresAt})`);

		this.sendSocketNotification(`ANSWER_${payload.identifier}`, resBody.results.answerSdp);
	},

	async extendStream(payload) {
		Log.info(`Extending Stream for module [${this.name}]`);
		const res = await fetch(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${payload.nestProjectId}/devices/${payload.nestDeviceId}:executeCommand`,
			{
				headers: {
					Authorization: `Bearer ${payload.token}`,
					"Content-Type": "application/json"
				},
				method: "POST",
				body: JSON.stringify({
					command: "sdm.devices.commands.CameraLiveStream.ExtendWebRtcStream",
					params: {
						mediaSessionId: mediaSessionId
					}
				})
			});

		const resBody = await res.json();

		if(resBody.error && resBody.error.code === 401){
			Log.info('Nest token invalid; Refreshing token');
			const url = `https://www.googleapis.com/oauth2/v4/token?client_id=${payload.nestClientId}&client_secret=${payload.nestClientSecret}&refresh_token=${payload.refreshToken}&grant_type=refresh_token`;
			const response = await fetch(url,
				{
					headers: {
						"Content-Type": "application/json"
					},
					method: "POST"
				});

			const resB = await response.json();

			this.sendSocketNotification(`REFRESH_${payload.identifier}`, resB);
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
