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
const getHistoryPath = () => path.join(__dirname, "event-history.json");
const HISTORY_STORE_CAP = 500;   // hard cap on persisted entries (display caps applied in the frontend)

// Pub/Sub streaming-pull recovery. The gRPC streaming pull can stop delivering
// without emitting an error — a NAT/router silently drops the idle TCP stream
// during a quiet spell and the client never notices (no reconnect, no error).
// A watchdog reopens the subscriber when nothing has arrived for a while; the
// keepalive pings below aim to prevent the idle drop in the first place.
const EVENT_STALL_MS = 30 * 60 * 1000;            // reopen if idle at least this long
const EVENT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // how often the watchdog checks
const PUBSUB_KEEPALIVE_OPTS = {
	"grpc.keepalive_time_ms": 5 * 60 * 1000,       // ping the server every 5 min…
	"grpc.keepalive_timeout_ms": 20 * 1000,        // …expect a pong within 20s
	"grpc.keepalive_permit_without_calls": 1,      // keepalive even with no active RPC
	"grpc.http2.max_pings_without_data": 0         // don't cap pings on an idle stream
};

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
		// Persisted event history (array of {deviceId, kind, label, at}), loaded from disk.
		this.eventHistory = this.loadHistory();
		this.setupControlServer();
	},

	loadHistory() {
		try {
			const data = fs.readFileSync(getHistoryPath(), "utf8");
			const parsed = JSON.parse(data);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	},

	saveHistory() {
		try {
			fs.writeFileSync(getHistoryPath(), JSON.stringify(this.eventHistory), "utf8");
		} catch (e) {
			Log.error(`[${this.name}] Failed to persist event history: ${e.message}`);
		}
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
  .row.test { margin-top:10px; }
  .row.test button { font-weight:500; font-size:13px; opacity:.8; background:#12161c; }
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
    var test =
      '<div class="row test">' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'test-motion\\')">Test motion flag</button>' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'test-doorbell\\')">Test doorbell flag</button>' +
      '</div>';
    return '<div class="inst">' +
      '<div class="row">' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'prev\\')">◀ Prev</button>' +
        '<button onclick="cmd(\\''+s.identifier+'\\',\\'next\\')">Next ▶</button>' +
      '</div>' +
      '<div class="cams">' + cams + '</div>' + cycle + test +
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
		// Once per process, kick Pub/Sub event publishing awake (see armEventPublishing).
		if (result.kind === "TOKEN" && !this._eventsArmed) {
			this._eventsArmed = true;
			this.armEventPublishing(result.tokens.access_token, payload.nestProjectId);
		}
	},

	// Google only (re)starts publishing camera events to the Pub/Sub topic after a
	// devices.list call — a one-time trigger required after each authorization (per the
	// Device Access docs). The frontend only ever calls executeCommand (streaming), so
	// without this, events stay dark after any token revoke/re-auth even though streaming
	// works. Fire devices.list once, right after we first obtain a valid token.
	async armEventPublishing(token, projectId) {
		if (!token || !projectId) return;
		try {
			const res = await fetch(
				`https://smartdevicemanagement.googleapis.com/v1/enterprises/${projectId}/devices`,
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			const body = await res.json();
			if (body.error) {
				Log.warn(`[${this.name}] devices.list (event arming) returned: ${JSON.stringify(body.error)}`);
			} else {
				Log.info(`[${this.name}] armed Pub/Sub event publishing via devices.list (${(body.devices || []).length} devices)`);
			}
		} catch (e) {
			Log.warn(`[${this.name}] devices.list (event arming) failed: ${e.message}`);
		}
	},

	sendTokenResult(identifier, result) {
		if (result.kind === "TOKEN") {
			this.sendSocketNotification(`TOKEN_${identifier}`, result.tokens);
		} else {
			this.sendSocketNotification(`NEED_AUTH_${identifier}`, { authUrl: result.authUrl });
		}
	},

	async resolveToken(payload) {
		let tokens = loadTokens();

		// 1. Prefer exchanging a *newly supplied* authorization code. A new code means
		//    the user just re-authorized (e.g. to change granted permissions), and that
		//    intent must win over the stale saved grant — refreshing the old token would
		//    silently discard the re-auth. We compare against the last-exchanged code so
		//    an already-used code left in config doesn't trigger a failed exchange on
		//    every restart. Single-use: on failure (expired/used) we fall through to the
		//    saved refresh token below, so the cameras keep working.
		if (payload.nestCode && payload.nestCode !== tokens?.exchangedCode) {
			const resBody = await this.exchangeCodeForTokens(payload);
			if (resBody.access_token) {
				const newTokens = {
					access_token: resBody.access_token,
					refresh_token: resBody.refresh_token || tokens?.refresh_token,
					exchangedCode: payload.nestCode
				};
				saveTokens(newTokens);
				Log.info("Exchanged new Nest authorization code for fresh tokens");
				return { kind: "TOKEN", tokens: newTokens };
			}
			Log.warn(`Nest code exchange failed; falling back to saved token: ${JSON.stringify(resBody)}`);
		}

		// 2. Refresh the saved token if we have a refresh_token.
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

		// 3. Use saved access_token if we have one (e.g. no refresh_token yet)
		if (tokens?.access_token) {
			return { kind: "TOKEN", tokens };
		}

		// 4. No valid tokens and no usable code
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

	// ---------------------------------------------------------------------------
	// Motion/doorbell events (Google Cloud Pub/Sub) — see MOTION-EVENTS-SETUP.md
	// ---------------------------------------------------------------------------

	// Classify a raw SDM Pub/Sub message body into { deviceId, kind } or null.
	// Pure function (no I/O) so it can be unit-tested. Exposed on the helper.
	classifyEvent(body) {
		const ru = body && body.resourceUpdate;
		if (!ru || !ru.name || !ru.events) return null;
		const deviceId = ru.name.split("/devices/")[1];
		if (!deviceId) return null;
		const types = Object.keys(ru.events);
		// kind drives behavior (doorbell=red, motion=amber); label is the human tag shown on the tile.
		let kind = null, label = null;
		if (types.some((t) => t.includes("DoorbellChime"))) { kind = "doorbell"; label = "DOORBELL"; }
		else if (types.some((t) => t.includes("CameraPerson"))) { kind = "motion"; label = "PERSON"; }
		else if (types.some((t) => t.includes("CameraMotion"))) { kind = "motion"; label = "MOTION"; }
		if (!kind) return null;   // ignore Sound / ClipPreview-only updates
		// eventSessionId groups every message Nest sends for ONE detection (Motion,
		// Person, ClipPreview, redeliveries…). We dedupe on it so one detection = one entry.
		let sessionId = null;
		for (const t of types) {
			if (ru.events[t] && ru.events[t].eventSessionId) { sessionId = ru.events[t].eventSessionId; break; }
		}
		return { deviceId, kind, label, sessionId };
	},

	handleEventMessage(message) {
		let body;
		try {
			body = JSON.parse(message.data.toString());
		} catch (e) {
			return;
		}
		// Log every received event (type + device) so the true cadence is observable
		// in magicmirror.log — Nest throttles camera events, so this helps distinguish
		// "no event arrived" from "event arrived but ignored/unmatched".
		const ru = body && body.resourceUpdate;
		if (ru && ru.events) {
			const dev = ru.name ? ru.name.split("/devices/").pop() : "?";
			Log.info(`[${this.name}] Pub/Sub event ${dev.slice(0, 12)}… types=[${Object.keys(ru.events).join(", ")}]`);
		}
		const evt = this.classifyEvent(body);
		if (evt) {
			// Dedupe: Nest sends several messages per detection (same eventSessionId).
			// Skip any we've already handled so one detection makes exactly one entry.
			if (evt.sessionId) {
				this._recentSessions = this._recentSessions || new Set();
				const key = `${evt.deviceId}|${evt.sessionId}`;
				if (this._recentSessions.has(key)) return;
				this._recentSessions.add(key);
				if (this._recentSessions.size > 300) {
					// bound the set: drop the oldest ~100 keys
					for (const k of [...this._recentSessions].slice(0, 100)) this._recentSessions.delete(k);
				}
			}
			// Timestamp from the event body when present, else receipt time.
			evt.at = Date.parse(body.timestamp) || Date.now();
			delete evt.sessionId;   // not needed in the stored/relayed payload
			// Persist to the history store (hard-capped; frontend applies display caps).
			this.eventHistory.push(evt);
			if (this.eventHistory.length > HISTORY_STORE_CAP) {
				this.eventHistory = this.eventHistory.slice(-HISTORY_STORE_CAP);
			}
			this.saveHistory();
			// Broadcast to all module instances; each frontend keeps only events for
			// a device it owns.
			this.sendSocketNotification("NEST_EVENT", evt);
		}
	},

	async initEvents(payload) {
		if (!payload || !payload.subscription || !payload.keyFile) return;
		this._eventSubs = this._eventSubs || {};
		if (this._eventSubs[payload.subscription]) return;   // already listening

		try {
			require("@google-cloud/pubsub");
		} catch (e) {
			Log.error(`[${this.name}] @google-cloud/pubsub not installed — run 'npm install' in the module folder. Motion events disabled.`);
			return;
		}

		const keyPath = path.join(__dirname, payload.keyFile);
		if (!fs.existsSync(keyPath)) {
			Log.error(`[${this.name}] Pub/Sub key file not found: ${keyPath}. Motion events disabled.`);
			return;
		}

		// Accept either a full resource path or a bare subscription id in config.
		const subId = payload.subscription.includes("/")
			? payload.subscription.split("/").pop()
			: payload.subscription;

		// Mark as listening up-front so a re-entrant INIT_EVENTS (e.g. a frontend
		// re-render) is a no-op even while we open the streaming pull.
		this._eventSubs[payload.subscription] = true;
		if (!this.openEventSubscription(keyPath, subId, payload.subscription)) {
			this._eventSubs[payload.subscription] = false;   // open failed; allow a retry
			return;
		}

		// Watchdog backstop: if the streaming pull silently stalls, reopen it. Pub/Sub
		// redelivers any backlog on reconnect and classifyEvent's eventSessionId dedupe
		// absorbs the redeliveries, so a reopen can't double-count events.
		this._lastEventAt = Date.now();
		if (!this._eventWatchdog) {
			this._eventWatchdog = setInterval(() => {
				const idleMs = Date.now() - (this._lastEventAt || 0);
				if (idleMs >= EVENT_STALL_MS) {
					Log.warn(`[${this.name}] no Nest events for ${Math.round(idleMs / 60000)}m — reopening Pub/Sub subscription`);
					this.openEventSubscription(keyPath, subId, payload.subscription);
					this._lastEventAt = Date.now();   // reset so we reopen at most once per stall window
				}
			}, EVENT_WATCHDOG_INTERVAL_MS);
		}
	},

	// Opens (or reopens) a Pub/Sub streaming pull for `subKey`. Tears down any
	// previous client/subscriber for that key first so a reopen fully resets the
	// gRPC channel. Returns true on success. Called on init and from the watchdog.
	openEventSubscription(keyPath, subId, subKey) {
		let PubSub;
		try {
			({ PubSub } = require("@google-cloud/pubsub"));
		} catch (e) {
			Log.error(`[${this.name}] @google-cloud/pubsub not installed. Motion events disabled.`);
			return false;
		}

		this._subscribers = this._subscribers || {};
		const prev = this._subscribers[subKey];
		if (prev) {
			try {
				prev.subscription.removeAllListeners();
				prev.subscription.close();
				prev.client.close();
			} catch (e) { /* best-effort teardown */ }
			delete this._subscribers[subKey];
		}

		let client, subscription;
		try {
			client = new PubSub({ keyFilename: keyPath, ...PUBSUB_KEEPALIVE_OPTS });
			subscription = client.subscription(subId);
		} catch (e) {
			Log.error(`[${this.name}] Pub/Sub init failed: ${e.message}`);
			return false;
		}

		subscription.on("message", (message) => {
			this._lastEventAt = Date.now();
			try {
				this.handleEventMessage(message);
			} finally {
				message.ack();
			}
		});
		subscription.on("error", (err) => {
			Log.error(`[${this.name}] Pub/Sub subscription error: ${err.message}`);
		});

		this._subscribers[subKey] = { client, subscription };
		Log.info(`[${this.name}] listening for Nest events on ${subKey}`);
		return true;
	},

	async socketNotificationReceived(notification, payload) {
		switch (notification) {
			case "START_STREAM":
				await this.sendOffer(payload);
				break;
			case "INIT_EVENTS":
				await this.initEvents(payload);
				break;
			case "GET_HISTORY":
				// Frontend requests the persisted event history on startup.
				this.sendSocketNotification(`HISTORY_${payload.identifier}`, this.eventHistory);
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
