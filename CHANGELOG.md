# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.3.1] – 2026-07-12

### Added
- `historyFontSize` config — set the history panel's text size (e.g. `"1.6em"`), so it can be compact in a corner or large in the centre.

### Fixed
- **History panel now works in an otherwise-empty region** (e.g. `middle_center`). MagicMirror's `updateWrapperStates()` hides any region container with no `.module` element, so the injected panel is now tagged `module` to keep the region visible.
- **Panel no longer stretches full-width.** The region's flex container was stretching it edge-to-edge; it now uses `align-self: center` to shrink to its content and centre. Rows use one shared grid so the three columns line up, with a subtle backdrop for legibility over busy content.

## [2.3.0] – 2026-07-08

### Added
- **Event history panel.** A chronological log of motion/person/doorbell events (newest first, `time · camera · type`), rendered into a configurable MagicMirror region.
  - `showEventHistory` enables it; `historyPosition` picks the region (any MM position, e.g. `top_left`, default); `historyMaxEntries` and `historyMaxAgeMs` bound what's shown.
  - **Persisted to disk** by `node_helper` (`event-history.json`, git-ignored) so the log survives restarts/reboots; the frontend seeds from it on startup (`GET_HISTORY`) and appends live events.
  - Type colour-coded (amber for motion/person, red for doorbell); rows resolve device IDs back to camera names.
- The panel is injected into the chosen region's container, so it can live in a different corner than the camera module itself.

### Notes
- Synthetic `Test motion/doorbell flag` events are not recorded in history (they don't reach `node_helper`).
- Persisted store is hard-capped at 500 entries; display limits (`historyMaxEntries` / `historyMaxAgeMs`) are applied client-side.

## [2.2.1] – 2026-07-07

### Fixed
- **Event flag is now readable.** The corner icon used emoji (🏃/🔔), which render as "tofu" boxes in the Pi's Electron (no colour-emoji font). Replaced with a glyph-safe text badge (`● PERSON` / `● MOTION` / `● DOORBELL`).
- **Made the flag unmistakable.** The motion/doorbell ring is now a thick, brightly pulsing border (amber / red) with a blinking badge, so a rare event stands out against the semi-transparent mirror overlay.

### Added
- **`Test motion flag` / `Test doorbell flag` buttons** on the `/nest-cam` web page (and `test-motion` / `test-doorbell` commands), so you can verify the flag renders without waiting for a real Nest event.
- `node_helper` logs every received Pub/Sub event (`Pub/Sub event <device> types=[…]`) to `magicmirror.log`, making the true event cadence observable.
- Event payloads now carry a display `label` (PERSON / MOTION / DOORBELL) distinct from the behavioural `kind`.

### Note
- **Nest throttles camera events.** Motion/person events arrive sparsely (not one per movement) — the doorbell chime is the most reliable trigger. This feature surfaces the camera *when Nest reports something*, it is not a continuous motion tracker.

## [2.2.0] – 2026-07-07

### Added
- **Motion-driven auto-focus.** With `enableMotionFocus` and a Google Cloud Pub/Sub subscription configured, the module receives Nest camera events (motion, person, doorbell chime) in real time and reacts:
  - **In auto-cycle mode**, the camera that triggered is promoted to hero for `motionHoldMs` (default 20s), then auto-cycle resumes.
  - **"Manual wins":** if you've manually picked a camera (keyboard/web/notification), motion never steals the hero — it only **flags the thumbnail** with a pulsing ring + corner icon (amber 🏃 for motion/person, red 🔔 for a doorbell), which fades after `motionHoldMs`.
- `node_helper` pulls events via `@google-cloud/pubsub` using a service-account key (`pubsubKeyFile`), classifies each event, and relays `NEST_EVENT{deviceId, kind}` to the frontend, which maps the device to its camera.
- New config: `enableMotionFocus`, `pubsubSubscription`, `pubsubKeyFile`, `motionHoldMs`.
- **[`MOTION-EVENTS-SETUP.md`](MOTION-EVENTS-SETUP.md)** — full step-by-step for the one-time Google Cloud / Device Access Pub/Sub setup, with a troubleshooting table for the common errors.

### Notes
- All existing features work **without** any of this — motion focus is off unless `enableMotionFocus` is set and Pub/Sub is configured.
- Sound-only and clip-preview-only events are ignored; a doorbell chime takes priority over motion in the same update.

## [2.1.0] – 2026-07-07

### Added
- **Keyboard / wireless-remote control.** The module now listens for key presses in the display, so any USB/Bluetooth numpad, presentation clicker, or mini keyboard plugged into the Pi can drive the hero camera — no extra module or driver. `1`–`9` focus a camera, arrows/PageUp-Down step Prev/Next, `Space` toggles auto-cycle.
- **Self-hosted web control page** at `http://<pi>:8080/nest-cam`, served by the module's `node_helper` on MagicMirror's own Express server (no MMM-Remote-Control dependency). Mobile-friendly buttons tap a camera to hero, step Prev/Next, and pause/resume auto-cycle; each camera shows live hero / available / No Signal status. The page is gated by MagicMirror's `ipWhitelist` and is only reachable off-Pi if `address` binds beyond localhost.
- Unified `applyControl()` path: the keyboard, the web page, and the `NEST_CAM_*` inter-module notifications now all funnel through one method, so every input source behaves identically.

### Notes
- Camera names rendered on the web page are HTML-escaped.
- The web page only reaches your phone after you open `address`/`ipWhitelist` in `config/config.js`, which also exposes the rest of the mirror UI to your LAN — see the README security note.

## [2.0.0] – 2026-07-05

### Added
- **Multi-camera support.** A single module instance can now drive multiple Nest cameras via a `cameras: [...]` array (shared account credentials at the top level, per-camera `name` + `nestDeviceId`).
- **Hero + thumbnails layout** (`layout: "hero"`, the default): one large primary camera with a strip of smaller live thumbnails.
- **Auto-cycle** (`cycleInterval`): automatically rotates which camera is the hero on an interval, without tearing down any stream.
- **Notification API** to control the hero camera from other modules (e.g. MMM-Remote-Control): `NEST_CAM_SET_HERO`, `NEST_CAM_NEXT`, `NEST_CAM_PREV`, `NEST_CAM_PAUSE_CYCLE`, `NEST_CAM_RESUME_CYCLE`.
- Per-camera connection isolation: a failure/reconnect on one camera no longer affects its siblings.
- Hero selection and auto-cycle skip offline / "No Signal" cameras, so a dead feed never occupies the hero spot; the hero hands off to a live camera when its current one drops.
- Frozen-video self-healing: a per-camera watchdog polls the decoded-frame counter and reconnects a camera whose video stalls (~21s with no new frames) even though its WebRTC track still reports "live" — no more manual MagicMirror restart to unstick a frozen feed.
- Fixed the most common freeze cause: re-rendering detaches each `<video>`, which pauses it in Chromium; cached tiles are now resumed on reuse and by the watchdog, so tiles no longer stick on a stale frame. Self-healing actions are logged to `magicmirror.log`.
- Camera name overlay label on each tile.
- Pluggable `layout` option with `grid` / `carousel` / `focus` reserved for a future release (they currently fall back to `hero`).

### Changed
- Internal WebRTC state and socket notifications are now namespaced per camera (`cameraId = ${identifier}__${index}`) instead of per module instance. The audio equalizer now renders on the hero camera only.
- Token/OAuth flow remains shared across all cameras (one Google account = one `tokens.json`); concurrent token fetches are de-duped.

### Compatibility
- **Existing single-camera configs keep working unchanged** — a top-level `nestDeviceId` (with no `cameras` array) is treated as a one-camera setup.

## [1.0.0] – 2026-03-24

### Added
- WebRTC streaming support for Google Nest cameras via the Device Access API
- OAuth 2.0 authentication flow with automatic token refresh
- Audio visualizer (frequency spectrum bar equalizer) synced to camera audio
- Auto-reconnection logic with configurable `reconnectDelay`
- Stream session extension via `extendInterval` to keep streams alive beyond the 5-minute Nest timeout
- User presence integration (`USER_PRESENCE` notification) to suspend/resume the stream
- `exchange-nest-code.js` CLI tool for initial OAuth authorization code exchange
- Support for `hiddenOnStartup` to defer WebRTC connection until the module is shown
