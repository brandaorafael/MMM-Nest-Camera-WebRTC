# Multi-Camera Architecture & Roadmap

This note records **why** the multi-camera feature is built the way it is, so the
design survives future edits. It mirrors the design-note style of
`ISSUE-auto-auth.md`.

## Goal

Show several Nest cameras from **one** module instance, with cross-camera layouts
and actions (auto-cycle, remote-driven hero selection) that a "one module block
per camera" approach cannot provide.

## Config shape

Shared account credentials live at the top level; cameras are listed in a
`cameras: []` array:

```js
config: {
  nestProjectId, nestClientId, nestClientSecret,   // one Google account
  layout: "hero",
  cycleInterval: 15000,
  cameras: [
    { name: "Front Door", nestDeviceId: "..." },
    { name: "Backyard",   nestDeviceId: "..." }
  ]
}
```

Back-compat: a top-level `nestDeviceId` with no `cameras` array is normalized into
a single-element camera list (`normalizeCameras()`), so old configs are untouched.

## The core problem: `identifier` collision

Before this feature, every WebRTC field was a singleton on the module object and
every socket notification was namespaced by `this.identifier` — unique per module
*instance*, but shared across all cameras that instance drives. The backend keyed
its `mediaSessionIds` map by the same `identifier`.

With one instance driving N cameras that collides two ways:
1. Camera B's `ANSWER_<identifier>` would be delivered to camera A's handler.
2. All cameras would overwrite one media-session slot in the backend.

## The fix: a per-camera `cameraId`

A stable key computed once per camera at config-normalization time:

```
cameraId = `${this.identifier}__${index}`
```

- **Frontend state** is now `this.cameras[cameraId] = { pc, stream, video, wrapper,
  canvas, noSignal, tokenExpired, timers…, audio… }`. Every WebRTC function takes a
  `cameraId` and operates on `const cam = this.cameras[cameraId]`.
- **Outgoing** socket payloads send `identifier: cameraId`.
- **Inbound** notifications are matched by suffix: `socketNotificationReceived`
  recovers the `cameraId` by testing `notification.endsWith('_' + cameraId)` against
  the known camera keys (robust to multi-underscore verbs like `TOKEN_EXPIRED`),
  then dispatches the verb onto that camera.
- **Backend** needs no structural change: it already echoes `payload.identifier`
  into reply names and keys `mediaSessionIds` by it, so distinct `cameraId` values
  give each camera its own slot automatically.

### Account-level vs per-camera notifications

Token/OAuth is **account-scoped** (one Google account = one `tokens.json`), so it is
namespaced by the bare module `identifier`, not a `cameraId`:

- Account-level: `GET_TOKEN` → `TOKEN_<identifier>` / `NEED_AUTH_<identifier>`.
  Fetched **once** per module (`requestToken()` guards with `this.tokenRequested`);
  the backend also de-dupes concurrent fetches onto one in-flight promise.
- Per-camera: `START_STREAM`/`ANSWER`, `EXTEND_STREAM`, `RECONNECT`, `REFRESH`,
  `TOKEN_EXPIRED` — all suffixed with `cameraId`.

The dispatcher checks the per-camera suffixes first, then the account suffix. Since
`cameraId` starts with `${identifier}__`, the two suffix spaces never overlap.

## Layout: pluggable, hero implemented

`getDom()` is a thin dispatcher that builds `<div class="rtw-root rtw-layout-X">`
and switches on `config.layout`. Only `renderHero()` is implemented; `renderGrid`
/ `renderCarousel` / `renderFocus` are stubs that fall back to hero. Each camera
tile is produced by `renderCameraTile(cameraId, isHero)`.

Two properties are load-bearing:

1. **Anti-flicker video reuse.** A cached `cam.wrapper`/`cam.video` is reused across
   renders when `cam.video.srcObject === cam.stream`. Switching the hero re-parents
   the *same* `<video>` element between the hero and thumbnail containers — the
   stream never restarts, so there's no flicker or reconnect.
2. **Sizing via CSS, not inline JS.** Hero/thumb widths come from CSS custom
   properties (`--hero-width`, `--thumb-width`) set on `.rtw-root`, so promote/demote
   is a pure re-parent. No per-render inline width churn.

**Equalizer on the hero only** (`_syncEqualizer`): the audio visualizer is CPU-heavy
and illegible on thumbnails, so the canvas + `AudioContext` are attached to the hero
tile and torn down when a camera is demoted.

## Actions

All input sources funnel through a single `applyControl(action, target)` method
(`action` ∈ `set|next|prev|pause|resume|toggle-cycle`), so they behave identically
and stay in sync. After each action the frontend pushes a `CONTROL_STATE` snapshot to
`node_helper` (roster + hero + cycle state) for the web control page.

- **Auto-cycle** (`cycleInterval`): `startCycle()`/`advanceHero()`/`setHero()`.
  `setHero` just sets `this.heroId` and `updateDom()`; all cameras stay live.
- **Notification-driven** (for remotes / MMM-Remote-Control): `NEST_CAM_SET_HERO`,
  `NEST_CAM_NEXT/PREV`, `NEST_CAM_PAUSE_CYCLE/RESUME_CYCLE` → `applyControl`.
  A manual pick pauses auto-cycle so it sticks.
- **Keyboard / wireless remote** (Phase 2, implemented): `startInputControl()`
  registers a `keydown` listener in the renderer. `1`–`9` → focus camera N,
  arrows/PageUp-Down → prev/next, `Space` → toggle cycle. Works with any USB/BT
  device that emits keystrokes (numpad, clicker, mini keyboard) — no driver.
- **Self-hosted web page** (Phase 2, implemented): `node_helper` registers
  `/nest-cam` (HTML), `/nest-cam/state` (JSON roster the page polls every 2s), and
  `/nest-cam/cmd` (relays a button press as a `CONTROL_CMD` socket notification →
  `applyControl` on the matching instance) on MagicMirror's Express server
  (`this.expressApp`). Gated by MM's `ipWhitelist`; only reachable off-Pi when
  `address` binds beyond localhost.

## Roadmap (phases)

- **Phase 1:** multi-camera core, `cameraId` keying, hero layout,
  auto-cycle, notification API, backend token de-dupe. Per-camera connection
  isolation (one camera failing never tears down siblings).
- **Phase 2 (this release):** input methods on the Pi — keyboard/wireless-remote
  control and a self-hosted `/nest-cam` web control page, both routed through
  `applyControl`. (MMM-Remote-Control still works too, via the notification API.)
- **Phase 3:** implement the `grid` / `carousel` / `focus` layout render branches
  (CSS scaffolding already exists).
- **Phase 4:** **motion-driven focus** — subscribe to SDM camera events
  (`CameraMotion.Motion`, `DoorbellChime.Chime`) via Google Cloud Pub/Sub
  (`@google-cloud/pubsub` + a service-account key + Device Access Console setup),
  map the event's device id → `cameraId`, emit `MOTION_<cameraId>`, and auto-promote
  that camera as hero with a hold timer that suppresses auto-cycle.

## Known constraint: Raspberry Pi decode load

Every configured camera streams live at once; each is a hardware H.264 decode. A Pi
handles ~2 comfortably; 3–4 concurrent 1080p streams may exceed the GPU's decode
budget. Mitigations to consider if it struggles: cap the number of live thumbnails
(show a poster frame for the rest), request lower thumbnail resolution, or keep only
the hero live. Phase 4's motion-driven model also naturally reduces steady-state load.
