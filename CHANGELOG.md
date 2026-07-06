# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.0.0] – 2026-07-05

### Added
- **Multi-camera support.** A single module instance can now drive multiple Nest cameras via a `cameras: [...]` array (shared account credentials at the top level, per-camera `name` + `nestDeviceId`).
- **Hero + thumbnails layout** (`layout: "hero"`, the default): one large primary camera with a strip of smaller live thumbnails.
- **Auto-cycle** (`cycleInterval`): automatically rotates which camera is the hero on an interval, without tearing down any stream.
- **Notification API** to control the hero camera from other modules (e.g. MMM-Remote-Control): `NEST_CAM_SET_HERO`, `NEST_CAM_NEXT`, `NEST_CAM_PREV`, `NEST_CAM_PAUSE_CYCLE`, `NEST_CAM_RESUME_CYCLE`.
- Per-camera connection isolation: a failure/reconnect on one camera no longer affects its siblings.
- Hero selection and auto-cycle skip offline / "No Signal" cameras, so a dead feed never occupies the hero spot; the hero hands off to a live camera when its current one drops.
- Frozen-video self-healing: a per-camera watchdog polls the decoded-frame counter and reconnects a camera whose video stalls (~21s with no new frames) even though its WebRTC track still reports "live" — no more manual MagicMirror restart to unstick a frozen feed.
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
