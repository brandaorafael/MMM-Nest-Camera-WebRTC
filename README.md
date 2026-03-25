# MMM-Nest-Camera-WebRTC

A [MagicMirror²](https://github.com/MichMich/MagicMirror) module that displays a live WebRTC stream from a Google Nest camera via the Device Access API. Includes an audio frequency visualizer synced to the camera's audio track.

<!-- Add screenshot of the module in action here -->

---

## What Credentials Do I Need?

| Credential | Config field | Where to get it |
|---|---|---|
| OAuth Client ID | `nestClientId` | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials |
| OAuth Client Secret | `nestClientSecret` | Same as above |
| Project ID | `nestProjectId` | [Device Access Console](https://console.nest.google.com/device-access/project-list) |
| Device ID | `nestDeviceId` | Nest API device list (see Requirements below) |

---

## Installation

**1. Navigate to your MagicMirror `modules` folder:**

```bash
cd ~/MagicMirror/modules
```

**2. Clone this repository:**

```bash
git clone https://github.com/brandaorafael/MMM-Nest-Camera-WebRTC
```

**3. Install dependencies:**

```bash
cd MMM-Nest-Camera-WebRTC && npm install
```

**4. Complete the OAuth setup** — run the included CLI tool to exchange your authorization code for tokens:

```bash
node exchange-nest-code.js
```

This writes a `tokens.json` file that the module reads at startup.

---

## Requirements

- A [Google Cloud project](https://console.cloud.google.com) with the **Smart Device Management API** enabled
- A project registered in the [Device Access Console](https://console.nest.google.com/device-access/project-list) (one-time $5 fee)
- OAuth 2.0 credentials (Client ID + Secret) from Google Cloud Console

**Getting your Device ID:** After OAuth setup, list devices:

```
GET https://smartdevicemanagement.googleapis.com/v1/enterprises/{nestProjectId}/devices
```

Refer to the [official docs](https://developers.google.com/nest/device-access/reference/rest/v1/enterprises.devices/list) for details.

---

## Configuration

Add the module to the `modules` array in your `config/config.js`:

```javascript
{
  module: "MMM-Nest-Camera-WebRTC",
  position: "bottom_left",
  config: {
    nestProjectId: "your-project-id",
    nestDeviceId: "your-device-id",
    nestClientId: "your-oauth-client-id",
    nestClientSecret: "your-oauth-client-secret",
  }
}
```

### Configuration Options

| Option | Default | Description |
|---|---|---|
| `nestProjectId` | `""` | **Required.** Your Device Access project ID. |
| `nestDeviceId` | `""` | **Required.** The Nest camera device ID. |
| `nestClientId` | `""` | **Required.** OAuth 2.0 client ID from Google Cloud Console. |
| `nestClientSecret` | `""` | **Required.** OAuth 2.0 client secret from Google Cloud Console. |
| `nestCode` | `""` | Authorization code for the initial token exchange. Used only once; leave empty after running `exchange-nest-code.js`. |
| `width` | `"33%"` | CSS width of the video element (e.g. `"33%"`, `"480px"`). |
| `reconnectDelay` | `3000` | Milliseconds to wait before reconnecting after a connection failure. |
| `extendInterval` | `240000` | Interval (ms) to extend the stream session. Nest sessions expire after 5 minutes; must be less than `300000`. |
| `hiddenOnStartup` | `false` | When `true`, defers the WebRTC connection until the module is made visible. |

---

## Updating

```bash
cd ~/MagicMirror/modules/MMM-Nest-Camera-WebRTC
git pull
npm install
```

---

## Troubleshooting

**"Connecting to Nest camera..." shown indefinitely**
- Check `nestProjectId` and `nestDeviceId` are correct.
- Verify the camera is online in the Google Home app.
- Check the MagicMirror log for `[MMM-Nest-Camera-WebRTC]` error lines.

**"Nest camera requires authentication" shown**
- Re-run `node exchange-nest-code.js` to refresh your tokens.
- Make sure `tokens.json` exists in the module folder — if not, the initial OAuth setup is incomplete.

**"Extend stream failed" errors in the log**
- The stream session expired or there was a token/session mismatch. Restart MagicMirror to re-establish the connection.
- Ensure `extendInterval` is less than `300000` (5 minutes).

**Video not appearing after stream connects**
- Confirm the camera supports WebRTC (Nest Cam and Doorbell models do; older "Works with Nest" devices may not).
- Check for `Video playback failed` warnings in the log — this usually indicates an autoplay policy issue.

**Auth errors (401/403) in the log**
- Your OAuth token may have expired. Re-run `node exchange-nest-code.js` to get fresh tokens.
- Confirm the Smart Device Management API is enabled in your Google Cloud project.

**Stream stops after exactly 5 minutes**
- `extendInterval` must be set to less than `300000`. The default `240000` (4 min) is correct — verify your config hasn't overridden it to a value ≥ 300000.

---

Based on the work done by [@shbatm](https://github.com/shbatm) for [MMM-RTSPtoWeb](https://github.com/shbatm/MMM-RTSPtoWeb)
