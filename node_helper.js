const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const Log = require("logger");

/**
 * Media session IDs keyed by the caller's `identifier`. For a single-camera
 * instance that is the module identifier; for multi-camera it is the per-camera
 * cameraId (`${moduleIdentifier}__${index}`), so each camera gets its own slot.
 */
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
		// Latest control state per module instance (pushed by the frontend), so the
		// self-hosted web control page can render live camera buttons.
		this.controlStates = {};
		this.setupControlServer();
	},

	// Register the web control page + command endpoints on MagicMirror's own
	// Express server (this.expressApp is set before start()). Reachable at
	// http://<pi>:8080/nest-cam — but only from IPs allowed by the config
	// `ipWhitelist`, and only if `address` binds beyond localhost.
	setupControlServer() {
		const app = this.expressApp;
		if (!app) {
			Log.warn(`[${this.name}] expressApp unavailable; web control page disabled`);
			return;
		}

		app.get("/nest-cam", (req, res) => {
			res.set("Content-Type", "text/html; charset=utf-8");
			res.send(this.controlPageHtml());
		});

		// Current roster/hero/cycle state for all instances (page polls this).
		app.get("/nest-cam/state", (req, res) => {
			res.json({ instances: Object.values(this.controlStates) });
		});

		// A button press → relayed to the frontend as CONTROL_CMD.
		app.get("/nest-cam/cmd", (req, res) => {
			const { id, action, target } = req.query;
			if (!id || !action) {
				res.status(400).json({ ok: false, error: "id and action required" });
				return;
			}
			this.sendSocketNotification("CONTROL_CMD", { identifier: id, action, target });
			res.json({ ok: true });
		});

		Log.info(`[${this.name}] web control page available at /nest-cam`);
	},

	controlPageHtml() {
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Nest Cameras</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#0d0f12; color:#e8eaed; padding:16px; }
  h1 { font-size:18px; font-weight:600; margin:4px 0 16px; letter-spacing:.02em; }
  .inst { margin-bottom:28px; }
  .row { display:flex; gap:10px; margin-bottom:12px; }
  .cams { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  button { font:inherit; color:inherit; border:1px solid #2a2f36; background:#171a1f;
           border-radius:14px; padding:16px; cursor:pointer; transition:transform .06s, background .15s; }
  button:active { transform:scale(.97); }
  .row button { flex:1; font-weight:600; font-size:16px; }
  .cam { display:flex; flex-direction:column; align-items:flex-start; gap:6px; min-height:76px; text-align:left; }
  .cam .n { font-size:16px; font-weight:600; }
  .cam .s { font-size:12px; opacity:.6; }
  .cam.hero { background:#12331f; border-color:#2e7d4f; }
  .cam.hero .s { color:#5fd08a; opacity:1; }
  .cam.off { opacity:.45; }
  .cam.off .s { color:#e0774a; opacity:1; }
  .wide { width:100%; margin-top:12px; font-weight:600; font-size:15px; }
  .muted { opacity:.5; font-size:13px; }
</style>
</head>
<body>
<h1>🎥 Nest Cameras</h1>
<div id="app" class="muted">Loading…</div>
<script>
  function cmd(id, action, target) {
    var q = "/nest-cam/cmd?id=" + encodeURIComponent(id) + "&action=" + action +
            (target != null ? "&target=" + target : "");
    fetch(q).then(function(){ setTimeout(refresh, 150); });
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }
  function renderInstance(s) {
    var cams = s.cameras.map(function(c){
      var cls = "cam" + (c.isHero ? " hero" : "") + (c.viewable ? "" : " off");
      var status = c.isHero ? "● LIVE — hero" : (c.viewable ? "tap to focus" : "No Signal");
      return '<button class="' + cls + '" onclick="cmd(\\''+s.identifier+'\\',\\'set\\','+c.index+')">' +
             '<span class="n">' + esc(c.name) + '</span>' +
             '<span class="s">' + status + '</span></button>';
    }).join("");
    var cycle = s.cycleConfigured
      ? '<button class="wide" onclick="cmd(\\''+s.identifier+'\\',\\''+(s.cyclePaused?"resume":"pause")+'\\')">' +
        (s.cyclePaused ? "▶ Resume auto-cycle" : "⏸ Pause auto-cycle") + '</button>'
      : "";
    return '<div class="inst">' +
      '<div class="row">' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'prev\\')">◀ Prev</button>' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'next\\')">Next ▶</button>' +
      '</div>' +
      '<div class="cams">' + cams + '</div>' + cycle +
    '</div>';
  }
  function refresh() {
    fetch("/nest-cam/state").then(function(r){ return r.json(); }).then(function(data){
      var insts = (data && data.instances) || [];
      var app = document.getElementById("app");
      if (!insts.length) { app.className = "muted"; app.textContent = "Waiting for MagicMirror…"; return; }
      app.className = "";
      app.innerHTML = insts.map(renderInstance).join("");
    }).catch(function(){});
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
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

	// All cameras share one Google account / one tokens.json. De-dupe concurrent
	// GET_TOKEN calls onto a single in-flight fetch, then reply to each caller's
	// identifier so N cameras never trigger N parallel OAuth refreshes.
	async getNestToken(payload) {
		if (this._tokenInFlight) {
			const result = await this._tokenInFlight;
			this.sendTokenResult(payload.identifier, result);
			return;
		}
		this._tokenInFlight = this.resolveToken(payload);
		let result;
		try {
			result = await this._tokenInFlight;
		} finally {
			this._tokenInFlight = null;
		}
		this.sendTokenResult(payload.identifier, result);
	},

	sendTokenResult(identifier, result) {
		if (result.kind === "TOKEN") {
			this.sendSocketNotification(`TOKEN_${identifier}`, result.tokens);
		} else {
			this.sendSocketNotification(`NEED_AUTH_${identifier}`, { authUrl: result.authUrl });
		}
	},

	async resolveToken(payload) {
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
				return { kind: "TOKEN", tokens: newTokens };
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
				return { kind: "TOKEN", tokens: newTokens };
			}
			Log.error(`Code exchange failed: ${JSON.stringify(resBody)}`);
		}

		// 3. Use saved access_token if we have one (e.g. no refresh_token yet)
		if (tokens?.access_token) {
			return { kind: "TOKEN", tokens };
		}

		// 4. No valid tokens and no nestCode (or exchange failed)
		return {
			kind: "NEED_AUTH",
			authUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${payload.nestClientId}&redirect_uri=https://www.google.com&response_type=code&scope=https://www.googleapis.com/auth/sdm.service&access_type=offline&prompt=consent`
		};
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
					this.sendSocketNotification(`TOKEN_EXPIRED_${payload.identifier}`, {});
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
					this.sendSocketNotification(`TOKEN_EXPIRED_${payload.identifier}`, {});
				}
			} else {
				// Camera offline / not currently streamable (e.g. 400 FAILED_PRECONDITION).
				// Frontend shows "No Signal" and retries on its 30s loop.
				this.sendSocketNotification(`STREAM_UNAVAILABLE_${payload.identifier}`, {});
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
					this.sendSocketNotification(`TOKEN_EXPIRED_${payload.identifier}`, {});
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
					this.sendSocketNotification(`TOKEN_EXPIRED_${payload.identifier}`, {});
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
			case "CLIENT_LOG":
				Log.info(`[${this.name}] ${payload.msg}`);
				break;
			case "CONTROL_STATE":
				// Frontend pushed its latest roster/hero/cycle state for the web page.
				this.controlStates[payload.identifier] = payload;
				break;
		}
	}
});
